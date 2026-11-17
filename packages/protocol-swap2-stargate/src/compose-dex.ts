import {decodeAbiParameters, decodeFunctionData, encodeFunctionData, getAddress, keccak256, parseAbi, slice, toHex, zeroAddress, type Hex, type PublicClient} from "viem";
import {LIFI_COMPOSE_PAYLOAD, LIFI_ETHEREUM_COMPOSER, type LifiStargateComposeProof} from "./compose.js";
import {assertStargate, sameAddress} from "./rpc.js";

export const COMPOSE_UNOSWAP_ABI = parseAbi(["function unoswap2(uint256 token, uint256 amount, uint256 minReturn, uint256 dex, uint256 dex2) returns (uint256)"]);
export const COMPOSE_POOL_ABI = parseAbi([
  "function token0() view returns (address)", "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
]);
export const COMPOSE_DEX_PINS = Object.freeze({
  router: "0x111111125421cA6dc452d289314280a0f8842A65" as Hex,
  routerCodeHash: "0xa5a286be4b80006cc547d7e899871aa01a0e0551e2a509233375405f92098c2f" as Hex,
  factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984" as Hex,
  factoryCodeHash: "0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69" as Hex,
  /** Observed four-byte suffix; its ownership/meaning is not an authorization signal. */
  calldataSuffix: "2a94d114",
});
export const UNOSWAP_FLAGS = Object.freeze({V3: 1n << 253n, NO_WRAP: 1n << 251n, ZERO_FOR_ONE: 1n << 247n});
const ADDRESS = (1n << 160n) - 1n, {V3, NO_WRAP, ZERO_FOR_ONE} = UNOSWAP_FLAGS;

/** Exactly two canonical Uniswap V3 pools from `input` to `output`, as read at `blockNumber`. */
export async function unoswap2V3Path(client: PublicClient, blockNumber: bigint, input: Hex, words: readonly [bigint, bigint], output: Hex) {
  let current = input;
  const pools: Hex[] = [], fees: number[] = [], tokens: Hex[] = [input];
  for (const encoded of words) {
    assertStargate((encoded >> 253n) === 1n && (encoded & ~(ADDRESS | V3 | NO_WRAP | ZERO_FOR_ONE)) === 0n, "unsupported compose DEX flags");
    const address = getAddress(toHex(encoded & ADDRESS, {size: 20}));
    const at = {address, abi: COMPOSE_POOL_ABI, blockNumber};
    const [token0, token1, fee] = await Promise.all([
      client.readContract({...at, functionName: "token0"}), client.readContract({...at, functionName: "token1"}), client.readContract({...at, functionName: "fee"}),
    ]);
    const canonical = await client.readContract({address: COMPOSE_DEX_PINS.factory, abi: COMPOSE_POOL_ABI, functionName: "getPool", args: [token0, token1, fee], blockNumber});
    assertStargate(sameAddress(canonical, address) && address !== zeroAddress && !sameAddress(token0, token1), "unreviewed compose DEX pool");
    const forward = (encoded & ZERO_FOR_ONE) !== 0n;
    assertStargate(sameAddress(current, forward ? token0 : token1), "compose DEX path input mismatch");
    current = forward ? token1 : token0;
    pools.push(address); fees.push(fee); tokens.push(current);
  }
  assertStargate(sameAddress(current, output), "compose DEX path output mismatch");
  return Object.freeze({pools: Object.freeze(pools), fees: Object.freeze(fees), tokens: Object.freeze(tokens)});
}

/**
 * Checks a narrow DEX operation independently of LI.FI discovery: one unoswap2
 * call, exactly two canonical Uniswap V3 pools, ERC20 in/out, no Permit2,
 * unwrapping, arbitrary target, native value or alternate recipient.
 * This is not a price quote or permission to sign. The caller must use finalized
 * RPC evidence; executable compose routes/retries are not wired into swap2 yet.
 */
export async function validateLifiUnoswap2Compose(p: LifiStargateComposeProof, client: PublicClient, blockNumber: bigint) {
  assertStargate(await client.getChainId() === 1 && p.bridge.intent.destination.chain === "eip155:1", "wrong compose DEX chain");
  const block = await client.getBlock({blockNumber});
  assertStargate(block.hash, "compose DEX block unavailable");
  const pins = COMPOSE_DEX_PINS;
  for (const [address, expectedHash] of [
    [pins.router, pins.routerCodeHash], [pins.factory, pins.factoryCodeHash],
    [LIFI_ETHEREUM_COMPOSER.receiver, LIFI_ETHEREUM_COMPOSER.receiverCodeHash],
    [LIFI_ETHEREUM_COMPOSER.executor, LIFI_ETHEREUM_COMPOSER.executorCodeHash],
  ] as const) {
    const code = await client.getCode({address, blockNumber});
    assertStargate(code && keccak256(code) === expectedHash, "compose DEX bytecode mismatch");
  }
  assertStargate(keccak256(p.message) === p.messageHash, "changed compose message");
  const [transactionId, swaps, recipient] = decodeAbiParameters(LIFI_COMPOSE_PAYLOAD, slice(p.message, 76));
  assertStargate(swaps.length === 1 && sameAddress(transactionId, p.transactionId) && sameAddress(recipient, p.recipient), "compose DEX action mismatch");
  const swap = swaps[0]!;
  assertStargate(sameAddress(swap.callTo, pins.router) && sameAddress(swap.approveTo, pins.router) && swap.requiresDeposit && swap.fromAmount > 0n && swap.fromAmount <= p.bridge.amount && swap.fromAmount === p.swap.fromAmount, "unsupported compose DEX target or amount");
  assertStargate(sameAddress(swap.sendingAssetId, p.bridge.intent.destination.token) && sameAddress(swap.receivingAssetId, p.finalToken) && swap.sendingAssetId !== zeroAddress && p.finalToken !== zeroAddress, "unsupported compose DEX assets");
  const call = decodeFunctionData({abi: COMPOSE_UNOSWAP_ABI, data: swap.callData});
  const [token, amount, minimum, dex, dex2] = call.args;
  // The pinned router's unoswap2 -> _unoswapTo2 -> _unoswapV3 path uses
  // decoded arguments, never trailing msg.data. Accept only the canonical
  // call or the exact four-byte suffix observed in our real receipt fixture.
  const canonicalCall = encodeFunctionData({abi: COMPOSE_UNOSWAP_ABI, functionName: "unoswap2", args: call.args}).toLowerCase();
  assertStargate([canonicalCall, canonicalCall + pins.calldataSuffix].includes(swap.callData.toLowerCase()), "noncanonical compose DEX calldata");
  assertStargate(token > 0n && token <= ADDRESS && sameAddress(toHex(token, {size: 20}), swap.sendingAssetId) && amount === swap.fromAmount && minimum > 0n && minimum >= p.minimum, "compose DEX input or minimum mismatch");
  const {pools} = await unoswap2V3Path(client, blockNumber, swap.sendingAssetId, [dex, dex2], p.finalToken);
  assertStargate((await client.getBlock({blockNumber})).hash === block.hash, "compose DEX block changed");
  return Object.freeze({adapter: "lifi-ethereum-unoswap2-v3" as const, amount, minimum, finalToken: p.finalToken, recipient: p.recipient, pools, blockNumber, blockHash: block.hash, executionSupported: false as const});
}

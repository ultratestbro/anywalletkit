import {encodeAbiParameters, encodeFunctionData, encodePacked, getAddress, keccak256, pad, parseAbi, toHex, type Address, type Hex, type PublicClient} from "viem";
import type {Quote} from "@anywalletkit/protocol-swap2-core/types";
import {STARGATE_ABI} from "./abi.js";
import {destinationAmount, sourceMinimum, splitSourceAmount} from "./amounts.js";
import {stargateChainActive} from "./availability.js";
import {LIFI_COMPOSE_ABI, LIFI_COMPOSE_PAYLOAD, LIFI_ETHEREUM_COMPOSER, stargateComposeOptions, type LifiStargateComposeProof} from "./compose.js";
import {COMPOSE_DEX_PINS, COMPOSE_POOL_ABI, COMPOSE_UNOSWAP_ABI, UNOSWAP_FLAGS, unoswap2V3Path} from "./compose-dex.js";
import {stargateRegistry} from "./deployments.js";
import type {StargateIntent} from "./intent.js";
import {createStargateQuoter, type StargateQuoteConfig, type StargateSendParam} from "./quote.js";
import type {StargateDeployment, StargateRegistry} from "./registry.js";
import {assertNotAborted, assertStargate, nonzeroAddress, safeReadError, sameAddress, stargateRpc} from "./rpc.js";
import {checkedStargateAccounting, checkedStargateSource, stargateFees} from "./source-tx.js";
import type {StargateTaxiProof} from "./tracking.js";

/**
 * Executable compose: Stargate Taxi into the pinned Ethereum LI.FI ReceiverStargateV2,
 * whose Executor runs one locally encoded 1inch V6 `unoswap2` through two canonical
 * Uniswap V3 pools and pays the final ERC20 to the user. The intent carries every
 * parameter, so a client rebuilds the source calldata byte for byte.
 */
export const STARGATE_COMPOSE_CHAIN = "eip155:1";
export const UNISWAP_V3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e" as Address;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;
/** One aggregate3 per lookup (QuoterV2 in small groups): no burst of parallel chunks against the RPC. */
const ONE_BATCH = 1 << 16, QUOTE_GROUP = 4;
/** Hop tokens tried between the bridged asset and the requested output (WETH, USDC, USDT). */
export const COMPOSE_INTERMEDIATES: readonly Address[] = Object.freeze([
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0xdAC17F958D2ee523a2206206994597C13D831ec7",
]);
const FEE_TIERS = [100, 500, 3000, 10_000] as const;
/** Gas the swap needs after the receiver's own `recoverGas` reserve (two V3 hops measured at ~166k). */
export const COMPOSE_SWAP_GAS = 400_000n;
const MIN_SWAP_GAS = 250_000n, MAX_COMPOSE_GAS = 2_000_000n;
/** Retry overhead above the compose gas: base cost, calldata and Endpoint bookkeeping. */
const RETRY_OVERHEAD = 250_000n;
// QuoterV2 is nonpayable but only ever eth_call'ed; its answer prices the route, the router enforces minReturn.
const QUOTER_ABI = parseAbi(["function quoteExactInput(bytes path, uint256 amountIn) view returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)"]);
const ADDRESS = (1n << 160n) - 1n, {V3, NO_WRAP, ZERO_FOR_ONE} = UNOSWAP_FLAGS;
const PREFIX = "stargate:2:compose";

export interface StargateComposeIntent {
  /** Bridge leg: recipient is the pinned LI.FI receiver, minimum is the exact swap input. */
  readonly bridge: StargateIntent;
  readonly recipient: Address;
  readonly finalToken: Address;
  readonly dex: readonly [bigint, bigint];
  readonly minReturn: bigint;
  readonly gas: bigint;
  readonly transactionId: Hex;
}

export const isStargateComposeIntent = (id: string): boolean => id.startsWith(`${PREFIX}:`);

export function stargateComposeIntentId(c: StargateComposeIntent): string {
  const b = c.bridge;
  return [PREFIX, b.source.eid, b.destination.eid, b.source.assetId, b.sender.toLowerCase(), c.recipient.toLowerCase(), b.amount, b.minimum, c.finalToken.toLowerCase(), toHex(c.dex[0]), toHex(c.dex[1]), c.minReturn, c.gas, c.transactionId.toLowerCase()].join(":");
}

export function parseStargateComposeIntent(id: string, registry: StargateRegistry): StargateComposeIntent {
  // The swap2 server appends its authenticated envelope after '~'.
  const fields = id.split("~", 1)[0]!.split(":");
  const [tag, version, mode, srcEid, dstEid, assetId, sender, recipient, amountText, fromText, finalToken, dex0, dex1, minText, gasText, transactionId] = fields;
  assertStargate(fields.length === 16 && `${tag}:${version}:${mode}` === PREFIX, "invalid compose intent identity");
  assertStargate([srcEid, dstEid, assetId, amountText, fromText, minText, gasText].every((v) => typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v)), "invalid compose intent amounts");
  assertStargate([dex0, dex1].every((v) => typeof v === "string" && /^0x[1-9a-f][0-9a-f]{0,63}$/.test(v)) && /^0x[0-9a-f]{64}$/.test(transactionId ?? "") && BigInt(transactionId!) !== 0n, "invalid compose intent fields");
  assertStargate(sender && recipient && finalToken && nonzeroAddress(sender) && nonzeroAddress(recipient) && nonzeroAddress(finalToken), "invalid compose intent actors");
  const source = registry.deployments.find((d) => String(d.eid) === srcEid && String(d.assetId) === assetId);
  const destination = registry.deployments.find((d) => String(d.eid) === dstEid && String(d.assetId) === assetId);
  assertStargate(source && destination && destination.chain === STARGATE_COMPOSE_CHAIN && source.kind !== "native" && destination.kind !== "native" && registry.route(source.chain, source.token, destination.chain, destination.token), "unreviewed compose route");
  assertStargate(!sameAddress(finalToken, destination.token), "compose output equals the bridged asset");
  const amount = BigInt(amountText!), fromAmount = BigInt(fromText!), minReturn = BigInt(minText!), gas = BigInt(gasText!);
  assertStargate(splitSourceAmount(amount, source.localDecimals, source.sharedDecimals).amountSD > 0n && fromAmount > 0n && minReturn > 0n && minReturn < (1n << 256n) && gas >= MIN_SWAP_GAS && gas <= MAX_COMPOSE_GAS, "invalid compose intent bounds");
  assertStargate(destinationAmount(sourceMinimum(fromAmount, source.localDecimals, destination.localDecimals, source.sharedDecimals), source.localDecimals, destination.localDecimals, source.sharedDecimals) === fromAmount, "unaligned compose bridge amount");
  const dex = [BigInt(dex0!), BigInt(dex1!)] as const;
  // NO_WRAP is read only by ethUnoswap*; it is inert for this ERC20 unoswap2 call. Permit2 and unwrap are refused.
  assertStargate(dex.every((w) => (w >> 253n) === 1n && (w & ~(ADDRESS | V3 | NO_WRAP | ZERO_FOR_ONE)) === 0n && (w & ADDRESS) !== 0n), "unsupported compose DEX word");
  const bridge: StargateIntent = Object.freeze({source, destination, mode: "taxi", sender: getAddress(sender), recipient: LIFI_ETHEREUM_COMPOSER.receiver, amount, minimum: fromAmount, nativeDrop: 0n});
  return Object.freeze({bridge, recipient: getAddress(recipient), finalToken: getAddress(finalToken), dex: Object.freeze(dex), minReturn, gas, transactionId: transactionId as Hex});
}

/** Canonical 1inch V6 `unoswap2` (no trailing bytes): exact bridged input, reviewed minimum. */
export function stargateComposeSwapCall(c: StargateComposeIntent): Hex {
  return encodeFunctionData({abi: COMPOSE_UNOSWAP_ABI, functionName: "unoswap2", args: [BigInt(c.bridge.destination.token), c.bridge.minimum, c.minReturn, c.dex[0], c.dex[1]]});
}

/** LI.FI ReceiverStargateV2 payload: one swap, deposit from the receiver, output to the user. */
export function stargateComposeMessage(c: StargateComposeIntent): Hex {
  const router = getAddress(COMPOSE_DEX_PINS.router);
  return encodeAbiParameters(LIFI_COMPOSE_PAYLOAD, [c.transactionId, [{callTo: router, approveTo: router, sendingAssetId: c.bridge.destination.token, receivingAssetId: c.finalToken, fromAmount: c.bridge.minimum, callData: stargateComposeSwapCall(c), requiresDeposit: true}], c.recipient]);
}

export function stargateComposeSendParam(c: StargateComposeIntent): StargateSendParam {
  const {source, destination} = c.bridge;
  return Object.freeze({dstEid: destination.eid, to: pad(LIFI_ETHEREUM_COMPOSER.receiver, {size: 32}), amountLD: c.bridge.amount,
    minAmountLD: sourceMinimum(c.bridge.minimum, source.localDecimals, destination.localDecimals, source.sharedDecimals),
    extraOptions: stargateComposeOptions(c.gas), composeMsg: stargateComposeMessage(c), oftCmd: "0x"});
}

/** Outcome evidence for a route this SDK built: the same checks as historical compose proofs. */
export function stargateComposeProof(c: StargateComposeIntent, bridge: StargateTaxiProof): LifiStargateComposeProof {
  const composeMsg = stargateComposeMessage(c);
  const message = encodePacked(["uint64", "uint32", "uint256", "bytes32", "bytes"], [bridge.nonce, c.bridge.source.eid, bridge.amount, pad(c.bridge.sender, {size: 32}), composeMsg]);
  return Object.freeze({bridge, transactionId: c.transactionId, message, messageHash: keccak256(message), recipient: c.recipient, finalToken: c.finalToken, minimum: c.minReturn,
    swap: Object.freeze({callTo: getAddress(COMPOSE_DEX_PINS.router), fromAmount: c.bridge.minimum}), executionSupported: true});
}

/** Gas a manual `lzCompose` retry must carry: never less than the swap needs above `recoverGas`. */
export function stargateComposeRetryGas(c: StargateComposeIntent, recoverGas: bigint): bigint {
  const floor = recoverGas + MIN_SWAP_GAS;
  return (c.gas > floor ? c.gas : floor) + RETRY_OVERHEAD;
}

/** Composer, executor, router and factory code plus receiver wiring, at one Ethereum block. */
export async function checkStargateComposer(client: PublicClient, destination: StargateDeployment, blockNumber: bigint): Promise<{recoverGas: bigint}> {
  assertStargate(await client.getChainId() === 1 && destination.chain === STARGATE_COMPOSE_CHAIN, "wrong compose chain");
  const pins = LIFI_ETHEREUM_COMPOSER;
  for (const [address, expected] of [[pins.receiver, pins.receiverCodeHash], [pins.executor, pins.executorCodeHash], [COMPOSE_DEX_PINS.router, COMPOSE_DEX_PINS.routerCodeHash], [COMPOSE_DEX_PINS.factory, COMPOSE_DEX_PINS.factoryCodeHash]] as const) {
    const code = await client.getCode({address, blockNumber});
    assertStargate(code && keccak256(code) === expected, "compose contract bytecode changed");
  }
  const at = {address: pins.receiver, abi: LIFI_COMPOSE_ABI, blockNumber};
  const [executor, endpoint, messaging, recoverGas] = await Promise.all([
    client.readContract({...at, functionName: "executor"}), client.readContract({...at, functionName: "endpointV2"}),
    client.readContract({...at, functionName: "tokenMessaging"}), client.readContract({...at, functionName: "recoverGas"}),
  ]);
  assertStargate(sameAddress(executor, pins.executor) && sameAddress(endpoint, destination.endpoint) && sameAddress(messaging, destination.tokenMessaging), "composer wiring changed");
  assertStargate(recoverGas + MIN_SWAP_GAS <= MAX_COMPOSE_GAS, "composer recovery reserve is out of range");
  return {recoverGas};
}

/** Best two-hop path over the pinned factory's pools, priced by QuoterV2 at one block. */
export async function quoteStargateComposeSwap(client: PublicClient, blockNumber: bigint, input: Address, output: Address, amount: bigint): Promise<{dex: readonly [bigint, bigint]; amountOut: bigint}> {
  const factory = getAddress(COMPOSE_DEX_PINS.factory);
  const legs = COMPOSE_INTERMEDIATES.filter((mid) => !sameAddress(mid, input) && !sameAddress(mid, output))
    .flatMap((mid) => FEE_TIERS.flatMap((fee) => [[input, mid, fee], [mid, output, fee]] as const));
  const pools = await client.multicall({multicallAddress: MULTICALL3, batchSize: ONE_BATCH, blockNumber, allowFailure: false,
    contracts: legs.map(([a, b, fee]) => ({address: factory, abi: COMPOSE_POOL_ABI, functionName: "getPool", args: [a, b, fee]} as const))});
  const pool = new Map(legs.map(([a, b, fee], i) => [`${a}:${b}:${fee}`, pools[i]!] as const));
  const paths: {mid: Address; fees: [number, number]; pools: [Address, Address]}[] = [];
  for (const mid of COMPOSE_INTERMEDIATES) for (const f0 of FEE_TIERS) for (const f1 of FEE_TIERS) {
    const p0 = pool.get(`${input}:${mid}:${f0}`), p1 = pool.get(`${mid}:${output}:${f1}`);
    if (p0 && p1 && nonzeroAddress(p0) && nonzeroAddress(p1)) paths.push({mid, fees: [f0, f1], pools: [p0, p1]});
  }
  assertStargate(paths.length, "no two-pool Uniswap V3 path for the requested output");
  // Simulations share one eth_call gas cap: a thin pool crossing many ticks can exhaust it, so it
  // may only sink its own small group. Groups run one after another to avoid an RPC burst.
  let best = -1, out = 0n;
  for (let start = 0; start < paths.length; start += QUOTE_GROUP) {
    const group = paths.slice(start, start + QUOTE_GROUP);
    const quotes = await client.multicall({multicallAddress: MULTICALL3, batchSize: ONE_BATCH, blockNumber, allowFailure: true,
      contracts: group.map((p) => ({address: UNISWAP_V3_QUOTER_V2, abi: QUOTER_ABI, functionName: "quoteExactInput", args: [encodePacked(["address", "uint24", "address", "uint24", "address"], [input, p.fees[0], p.mid, p.fees[1], output]), amount]} as const))});
    quotes.forEach((q, i) => { if (q.status === "success" && q.result[0] > out) { out = q.result[0]; best = start + i; } });
  }
  assertStargate(best >= 0 && out > 0n, "no Uniswap V3 path can fill the bridged amount");
  // Same flag pattern as 1inch's own ERC20 unoswap2 routes: NO_WRAP on the first hop.
  const p = paths[best]!, word = (address: Address, from: Address, to: Address) => BigInt(address) | V3 | (BigInt(from) < BigInt(to) ? ZERO_FOR_ONE : 0n);
  return {dex: Object.freeze([word(p.pools[0], input, p.mid) | NO_WRAP, word(p.pools[1], p.mid, output)]) as readonly [bigint, bigint], amountOut: out};
}

/** Price the exact pools a reviewed intent names, at one block. */
async function quoteIntentPath(client: PublicClient, blockNumber: bigint, c: StargateComposeIntent): Promise<bigint> {
  const {fees, tokens} = await unoswap2V3Path(client, blockNumber, c.bridge.destination.token, c.dex, c.finalToken);
  const path = encodePacked(["address", "uint24", "address", "uint24", "address"], [tokens[0]!, fees[0]!, tokens[1]!, fees[1]!, tokens[2]!]);
  const [amountOut] = await client.readContract({address: UNISWAP_V3_QUOTER_V2, abi: QUOTER_ABI, functionName: "quoteExactInput", args: [path, c.bridge.minimum], blockNumber});
  return amountOut;
}

export function checkedStargateComposeQuote(q: Quote, registry: StargateRegistry) {
  const compose = parseStargateComposeIntent(q.intentId, registry), {source, destination, sender, amount, minimum} = compose.bridge;
  const {tx, cap} = checkedStargateSource(q, source, destination, amount, "compose");
  assertStargate(q.minDestAmount === String(compose.minReturn), "quote identity mismatch");
  const sendParam = stargateComposeSendParam(compose);
  // Re-encode, rather than ignoring unknown fields, trailing bytes or a changed refund recipient.
  const expected = encodeFunctionData({abi: STARGATE_ABI, functionName: "sendToken", args: [sendParam, {nativeFee: cap, lzTokenFee: 0n}, sender]});
  assertStargate(tx.data.toLowerCase() === expected.toLowerCase(), "calldata differs from the reviewed intent");
  assertStargate(/^[0-9]{1,78}$/.test(q.destAmount) && BigInt(q.destAmount) >= compose.minReturn, "invalid quoted output");
  checkedStargateAccounting(q, source, destination, amount, cap, minimum);
  assertStargate(q.providerData!.nativeDrop === "0", "native drop display mismatch");
  return {compose, sendParam, cap, tx};
}

export interface StargateComposeConfig {
  /** Explicit opt-in on both the quoting backend and the client pins. Default false. */
  enabled?: boolean;
  /** Swap gas above the receiver's recoverGas. Default 400k. */
  swapGas?: bigint;
}
export interface StargateComposeRequest {
  sourceChain: string;
  sourceToken: string;
  finalToken: string;
  sender: string;
  recipient: string;
  amount: bigint;
  /** Caller floor in final-token units. */
  minimum?: bigint;
  slippageBps?: number;
}

export function createStargateComposer(config: StargateQuoteConfig & {compose?: StargateComposeConfig}) {
  const registry = config.registry ?? stargateRegistry;
  const rpc = stargateRpc(config), quoter = createStargateQuoter(config);
  const swapGas = config.compose?.swapGas ?? COMPOSE_SWAP_GAS;
  assertStargate(typeof swapGas === "bigint" && swapGas >= MIN_SWAP_GAS && swapGas <= MAX_COMPOSE_GAS, "invalid compose swap gas");
  const bridged = (chain: string, token: string) => {
    const source = registry.find(chain, token);
    const destination = source && registry.deployments.find((d) => d.chain === STARGATE_COMPOSE_CHAIN && d.assetId === source.assetId);
    return source && destination && source.kind !== "native" && destination.kind !== "native" && registry.route(source.chain, source.token, destination.chain, destination.token) ? {source, destination} : undefined;
  };
  function supportsRoute(sourceChain: string, sourceToken: string, destinationChain: string, finalToken: string): boolean {
    const route = destinationChain === STARGATE_COMPOSE_CHAIN ? bridged(sourceChain, sourceToken) : undefined;
    return !!route && nonzeroAddress(finalToken) && !sameAddress(finalToken, route.destination.token) && stargateChainActive(sourceChain) && stargateChainActive(STARGATE_COMPOSE_CHAIN) && rpc.has(sourceChain) && rpc.has(STARGATE_COMPOSE_CHAIN);
  }
  async function quote(request: StargateComposeRequest, signal?: AbortSignal): Promise<Quote> {
    try {
      const r = {...request};
      const route = bridged(r.sourceChain, r.sourceToken);
      assertStargate(route && supportsRoute(r.sourceChain, r.sourceToken, STARGATE_COMPOSE_CHAIN, r.finalToken), "unsupported compose route");
      assertStargate(nonzeroAddress(r.sender) && nonzeroAddress(r.recipient), "sender and recipient must be nonzero EVM addresses");
      const slippage = r.slippageBps ?? 0, minimum = r.minimum ?? 0n;
      assertStargate(Number.isInteger(slippage) && slippage >= 0 && slippage < 10_000 && typeof minimum === "bigint" && minimum >= 0n && minimum < (1n << 256n), "invalid slippage or minimum");
      const {source, destination} = route, recipient = getAddress(r.recipient), finalToken = getAddress(r.finalToken);
      const eth = rpc.client(STARGATE_COMPOSE_CHAIN, signal), block = await rpc.snapshot(eth, 1);
      const {recoverGas} = await checkStargateComposer(eth, destination, block.number);
      const gas = recoverGas + swapGas;
      assertStargate(gas <= MAX_COMPOSE_GAS, "compose gas exceeds the cap");
      const transactionId = toHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
      let built: StargateComposeIntent | undefined, amountOut = 0n;
      const q = await quoter.quote({sourceChain: source.chain, sourceToken: source.token, destinationChain: destination.chain, destinationToken: destination.token, sender: r.sender, recipient: LIFI_ETHEREUM_COMPOSER.receiver, amount: r.amount, mode: "taxi",
        compose: {gas, async message(received, s) {
          const swap = await quoteStargateComposeSwap(rpc.client(STARGATE_COMPOSE_CHAIN, s), block.number, destination.token, finalToken, received);
          const floor = (swap.amountOut * BigInt(10_000 - slippage) + 9999n) / 10_000n, minReturn = minimum > floor ? minimum : floor;
          assertStargate(minReturn > 0n && minReturn <= swap.amountOut, "output is below the caller's minimum");
          amountOut = swap.amountOut;
          built = {bridge: {source, destination, mode: "taxi", sender: getAddress(r.sender), recipient: LIFI_ETHEREUM_COMPOSER.receiver, amount: r.amount, minimum: received, nativeDrop: 0n}, recipient, finalToken, dex: swap.dex, minReturn, gas, transactionId};
          return stargateComposeMessage(built);
        }},
      }, signal);
      assertStargate(built && q.minimumDestinationAmount === built.bridge.minimum && q.destinationAmount === built.bridge.minimum, "bridge output is not exact");
      await rpc.unchanged(eth, block);
      assertNotAborted(signal);
      const intent = Object.freeze({...built, bridge: Object.freeze(built.bridge)});
      const data = encodeFunctionData({abi: STARGATE_ABI, functionName: "sendToken", args: [stargateComposeSendParam(intent), {nativeFee: q.messagingFeeCap, lzTokenFee: 0n}, q.sender]});
      assertStargate(data === encodeFunctionData({abi: STARGATE_ABI, functionName: "sendToken", args: [q.sendParam, {nativeFee: q.messagingFeeCap, lzTokenFee: 0n}, q.sender]}), "compose encoding drifted");
      const out: Quote = {
        provider: "stargate", routeId: "compose", intentId: stargateComposeIntentId(intent), depositAddress: "", depositMemo: null,
        sourceAmount: String(r.amount), destAmount: String(amountOut), minDestAmount: String(intent.minReturn),
        txRequest: {to: source.address, data, value: String(q.nativeValue), nativeFee: String(q.messagingFeeCap), chainId: source.chainId, ...(source.approvalRequired ? {approvalAddress: source.address} : {})},
        feeUsd: 0, etaSeconds: null, reliability: 0.85, validUntilMs: q.validUntilMs,
        fees: stargateFees(source, q.protocolFee, q.messagingFeeCap),
        providerData: {sentAmount: String(q.sentAmount), dust: String(q.dust), protocolFee: String(q.protocolFee), protocolReward: String(q.protocolReward), messagingFee: String(q.messagingFee), nativeDrop: "0", sourceBlock: String(q.sourceBlock.number), sourceBlockHash: q.sourceBlock.hash, destinationBlock: String(block.number), destinationBlockHash: block.hash,
          bridgedAmount: String(intent.bridge.minimum), bridgedToken: destination.token, composer: LIFI_ETHEREUM_COMPOSER.receiver, composeGas: String(gas), recoverGas: String(recoverGas), liquidityReserved: "false", feeUsdKnown: "false", sourceGas: "unknown", approvalGas: "unknown"},
      };
      checkedStargateComposeQuote(out, registry);
      return out;
    } catch (error) { throw safeReadError(error); }
  }
  /** Client-side preflight: fresh bridge fee and exact output, pinned composer code, canonical pools, live price. */
  async function verifyBuild(c: StargateComposeIntent, cap: bigint): Promise<void> {
    const b = c.bridge;
    const fresh = await quoter.quote({sourceChain: b.source.chain, sourceToken: b.source.token, destinationChain: b.destination.chain, destinationToken: b.destination.token, sender: b.sender, recipient: b.recipient, amount: b.amount, mode: "taxi",
      compose: {gas: c.gas, message: async (received) => { assertStargate(received === b.minimum, "bridge output changed"); return stargateComposeMessage(c); }},
    });
    assertStargate(fresh.messagingFee <= cap, "messaging fee exceeds the reviewed cap");
    const eth = rpc.client(STARGATE_COMPOSE_CHAIN), block = await rpc.snapshot(eth, 1);
    const {recoverGas} = await checkStargateComposer(eth, b.destination, block.number);
    assertStargate(c.gas >= recoverGas + MIN_SWAP_GAS, "compose gas no longer covers the swap");
    assertStargate(await quoteIntentPath(eth, block.number, c) >= c.minReturn, "destination price moved below the reviewed minimum");
    await rpc.unchanged(eth, block);
  }
  return Object.freeze({supportsRoute, quote, verifyBuild});
}

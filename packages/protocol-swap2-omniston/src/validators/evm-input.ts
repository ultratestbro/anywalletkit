import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
  type Hex,
} from "viem";
import {
  OMNISTON_EVM_LOOKBACK_BLOCKS,
  OMNISTON_EVM_MIN_CONFIRMATIONS,
  omnistonEvmRpcRequest,
  type OmnistonRpcRequest,
  type OmnistonRpcUrls,
} from "./evm-output.js";

/**
 * EVM→TON: proves the trader's SOURCE position before the HTLC secret is
 * disclosed. The Omniston escrow factory (a 1inch cross-chain-swap fork with a
 * `parameters` tail on both immutables structs) emits `SrcEscrowCreated` from
 * the order's post-interaction once the resolver filled the signed order and
 * the maker's tokens plus the resolver's safety deposit sit in the
 * deterministic escrow. Everything below is read from the trusted factory and
 * the escrow itself; the Omniston tracking feed only supplied the address.
 */

const IMMUTABLES = [
  {name: "orderHash", type: "bytes32"},
  {name: "hashlock", type: "bytes32"},
  {name: "maker", type: "uint256"},
  {name: "taker", type: "uint256"},
  {name: "token", type: "uint256"},
  {name: "amount", type: "uint256"},
  {name: "safetyDeposit", type: "uint256"},
  {name: "timelocks", type: "uint256"},
  {name: "parameters", type: "bytes"},
] as const;
const DST_COMPLEMENT = [
  {name: "maker", type: "uint256"},
  {name: "amount", type: "uint256"},
  {name: "token", type: "uint256"},
  {name: "safetyDeposit", type: "uint256"},
  {name: "chainId", type: "uint256"},
  {name: "parameters", type: "bytes"},
] as const;
const FACTORY_ABI = [
  {
    type: "event",
    name: "SrcEscrowCreated",
    inputs: [
      {name: "srcImmutables", type: "tuple", components: IMMUTABLES, indexed: false},
      {name: "dstImmutablesComplement", type: "tuple", components: DST_COMPLEMENT, indexed: false},
    ],
  },
  {
    type: "function",
    name: "addressOfEscrowSrc",
    stateMutability: "view",
    inputs: [{name: "immutables", type: "tuple", components: IMMUTABLES}],
    outputs: [{name: "escrow", type: "address"}],
  },
  {type: "function", name: "FACTORY", stateMutability: "view", inputs: [], outputs: [{type: "address"}]},
  {type: "function", name: "balanceOf", stateMutability: "view", inputs: [{name: "account", type: "address"}], outputs: [{type: "uint256"}]},
] as const;

/** keccak256 of the event signature with the structs expanded (live Base 2026-10-16: 0x1140dcf8…). */
export const SRC_ESCROW_CREATED_TOPIC = keccak256(stringToHex(
  "SrcEscrowCreated((bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,bytes),(uint256,uint256,uint256,uint256,uint256,bytes))",
));

/** Timelock stages (seconds after deploy) of the audited v1beta8 profile:
 *  src withdrawal, src public withdrawal, src cancellation, src public
 *  cancellation, dst withdrawal, dst public withdrawal, dst cancellation. */
const SRC_STAGES = [1n, 120n, 240n, 300n, 1n, 120n, 180n] as const;
const SRC_CANCELLATION_STAGE = 2;
/** Disclosure is refused this close to the source cancellation stage: the
 *  resolver could otherwise withdraw the input while the TON position (which
 *  cancels 60 s earlier) can no longer be completed. */
const DISCLOSURE_MARGIN_SECONDS = 45n;
const UINT32_MASK = (1n << 32n) - 1n;
const ADDRESS_MASK = (1n << 160n) - 1n;

export interface EvmInputValidationInput {
  chain: string;
  positionAddress: string;
  factoryAddress: string;
  orderProtocolAddress: string;
  ownerAddress: string;
  resolverAddress: string;
  inputTokenAddress: string;
  inputUnits: string;
  resolverSendsUnits: string;
  srcHtlcSecurityDepositUnits: string;
  quoteTimestamp: number;
  secretHash: Uint8Array;
  /** EVM destination only: the destination complement must name this chain, token and deposit. */
  destinationChainId?: number;
  destinationTokenAddress?: string;
  dstSecurityDepositUnits?: string;
}

interface RpcLog {
  address: string;
  data: Hex;
  topics: Hex[];
  transactionHash: Hex;
  blockNumber: Hex;
}

function quantity(value: bigint): Hex {
  return `0x${value.toString(16)}`;
}

function uintAddress(value: bigint): string {
  return getAddress(`0x${(value & ADDRESS_MASK).toString(16).padStart(40, "0")}`);
}

function bytesHex(bytes: Uint8Array): Hex {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function stage(timelocks: bigint, index: number): bigint {
  return (timelocks >> BigInt(index * 32)) & UINT32_MASK;
}

async function ethCall(request: OmnistonRpcRequest, chain: string, to: string, data: Hex): Promise<Hex> {
  return await request(chain, "eth_call", [{to, data}, "latest"]) as Hex;
}

export function createOmnistonEvmInputValidator(options: {request?: OmnistonRpcRequest; rpcUrls?: OmnistonRpcUrls; now?: () => number} = {}) {
  const request: OmnistonRpcRequest = options.request ?? ((chain, method, params) => omnistonEvmRpcRequest(chain, method, params, options.rpcUrls));
  const now = options.now ?? Date.now;
  return async (input: EvmInputValidationInput): Promise<boolean> => {
    try {
      if (
        !OMNISTON_EVM_LOOKBACK_BLOCKS[input.chain] ||
        !isAddress(input.positionAddress) || !isAddress(input.factoryAddress) || !isAddress(input.orderProtocolAddress) ||
        !isAddress(input.ownerAddress) || !isAddress(input.resolverAddress) || !isAddress(input.inputTokenAddress) ||
        !Number.isInteger(input.quoteTimestamp) || input.quoteTimestamp * 1000 > now() + 120_000 ||
        now() - input.quoteTimestamp * 1000 > 6 * 60 * 60 * 1000 || input.secretHash.length !== 32
      ) return false;
      const position = getAddress(input.positionAddress);
      const factory = getAddress(input.factoryAddress);
      const owner = getAddress(input.ownerAddress);
      const resolver = getAddress(input.resolverAddress);
      const token = getAddress(input.inputTokenAddress);
      const secretHash = bytesHex(input.secretHash).toLowerCase();
      const inputUnits = BigInt(input.inputUnits);
      const resolverSendsUnits = BigInt(input.resolverSendsUnits);
      const safetyDeposit = BigInt(input.srcHtlcSecurityDepositUnits);
      if (inputUnits <= 0n || resolverSendsUnits <= 0n || safetyDeposit <= 0n) return false;

      const latest = BigInt(await request(input.chain, "eth_blockNumber", []) as string);
      const minConfirmations = OMNISTON_EVM_MIN_CONFIRMATIONS[input.chain] ?? 20n;
      const newestFinal = latest >= minConfirmations ? latest - minConfirmations : 0n;
      const lookback = OMNISTON_EVM_LOOKBACK_BLOCKS[input.chain]!;
      const oldest = newestFinal > lookback ? newestFinal - lookback : 0n;
      let match: {log: RpcLog; immutables: {
        orderHash: Hex; hashlock: Hex; maker: bigint; taker: bigint; token: bigint; amount: bigint; safetyDeposit: bigint; timelocks: bigint; parameters: Hex;
      }; complement: {maker: bigint; amount: bigint; token: bigint; safetyDeposit: bigint; chainId: bigint; parameters: Hex}} | undefined;
      for (let to = newestFinal; to >= oldest && !match;) {
        const from = to - oldest > 4_999n ? to - 4_999n : oldest;
        const logs = await request(input.chain, "eth_getLogs", [{
          address: factory,
          topics: [SRC_ESCROW_CREATED_TOPIC],
          fromBlock: quantity(from),
          toBlock: quantity(to),
        }]) as RpcLog[];
        for (const log of logs) {
          if (getAddress(log.address) !== factory) continue;
          try {
            const decoded = decodeEventLog({abi: FACTORY_ABI, eventName: "SrcEscrowCreated", data: log.data, topics: log.topics as [Hex, ...Hex[]]});
            if (decoded.args.srcImmutables.hashlock.toLowerCase() === secretHash) {
              match = {log, immutables: decoded.args.srcImmutables, complement: decoded.args.dstImmutablesComplement};
              break;
            }
          } catch {
            /* a foreign log shape is not ours */
          }
        }
        if (from === oldest) break;
        to = from - 1n;
      }
      if (!match) return false;
      const {immutables, complement, log} = match;
      const deployedAt = stage(immutables.timelocks, 7);
      // What the resolver filled must be exactly what the wallet signed: the
      // trader's full input, for this resolver, with the quoted deposit and
      // the pinned timelocks; the complement binds the TON output amount.
      if (
        uintAddress(immutables.maker) !== owner || uintAddress(immutables.taker) !== resolver ||
        uintAddress(immutables.token) !== token || immutables.amount !== inputUnits ||
        immutables.safetyDeposit !== safetyDeposit || immutables.parameters !== "0x" ||
        SRC_STAGES.some((expected, index) => stage(immutables.timelocks, index) !== expected) ||
        deployedAt < BigInt(input.quoteTimestamp) - 120n || deployedAt > BigInt(input.quoteTimestamp) + 900n ||
        complement.amount !== resolverSendsUnits
      ) return false;
      // EVM destination: the complement the factory recorded must point at the
      // quoted chain, token and destination deposit (TON keeps its own terms).
      if (input.destinationChainId !== undefined && (
        complement.chainId !== BigInt(input.destinationChainId) ||
        !input.destinationTokenAddress || !isAddress(input.destinationTokenAddress) ||
        uintAddress(complement.token) !== getAddress(input.destinationTokenAddress) ||
        complement.safetyDeposit !== BigInt(input.dstSecurityDepositUnits ?? "-1")
      )) return false;

      // The escrow address is a function of the immutables (CREATE2 through
      // the factory): the feed's address must be that function's value.
      const derived = decodeFunctionResult({
        abi: FACTORY_ABI,
        functionName: "addressOfEscrowSrc",
        data: await ethCall(request, input.chain, factory, encodeFunctionData({abi: FACTORY_ABI, functionName: "addressOfEscrowSrc", args: [immutables]})),
      });
      if (getAddress(derived) !== position) return false;

      const [receipt, block, code] = await Promise.all([
        request(input.chain, "eth_getTransactionReceipt", [log.transactionHash]) as Promise<{status: Hex; blockNumber: Hex} | null>,
        request(input.chain, "eth_getBlockByNumber", [log.blockNumber, false]) as Promise<{timestamp: Hex} | null>,
        request(input.chain, "eth_getCode", [position, "latest"]) as Promise<Hex>,
      ]);
      if (
        !receipt || !block || !code || code === "0x" || receipt.status !== "0x1" ||
        BigInt(receipt.blockNumber) !== BigInt(log.blockNumber) ||
        latest - BigInt(receipt.blockNumber) < minConfirmations ||
        BigInt(block.timestamp) !== deployedAt
      ) return false;
      // Still early enough to complete: the resolver must not be able to
      // cancel the source leg (and keep the TON side) once the secret is out.
      const nowSeconds = BigInt(Math.floor(now() / 1000));
      if (nowSeconds + DISCLOSURE_MARGIN_SECONDS >= deployedAt + SRC_STAGES[SRC_CANCELLATION_STAGE]) return false;

      const [reportedFactory, tokenBalance, nativeBalance] = await Promise.all([
        ethCall(request, input.chain, position, encodeFunctionData({abi: FACTORY_ABI, functionName: "FACTORY"}))
          .then((data) => decodeFunctionResult({abi: FACTORY_ABI, functionName: "FACTORY", data})),
        ethCall(request, input.chain, token, encodeFunctionData({abi: FACTORY_ABI, functionName: "balanceOf", args: [position]}))
          .then((data) => decodeFunctionResult({abi: FACTORY_ABI, functionName: "balanceOf", data})),
        request(input.chain, "eth_getBalance", [position, "latest"]) as Promise<Hex>,
      ]);
      return getAddress(reportedFactory) === factory && tokenBalance >= inputUnits && BigInt(nativeBalance) >= safetyDeposit;
    } catch {
      return false;
    }
  };
}

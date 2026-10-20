import {
  decodeAbiParameters,
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
  type Hex,
} from "viem";

const ESCROW_FACTORY_ABI = [
  {
    type: "function",
    name: "createDstEscrow",
    stateMutability: "payable",
    inputs: [
      {
        name: "dstImmutables",
        type: "tuple",
        components: [
          {name: "orderHash", type: "bytes32"},
          {name: "hashlock", type: "bytes32"},
          {name: "maker", type: "uint256"},
          {name: "taker", type: "uint256"},
          {name: "token", type: "uint256"},
          {name: "amount", type: "uint256"},
          {name: "safetyDeposit", type: "uint256"},
          {name: "timelocks", type: "uint256"},
          {name: "parameters", type: "bytes"},
        ],
      },
      {name: "srcCancellationTimestamp", type: "uint256"},
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "addressOfEscrowDst",
    stateMutability: "view",
    inputs: [
      {
        name: "immutables",
        type: "tuple",
        components: [
          {name: "orderHash", type: "bytes32"},
          {name: "hashlock", type: "bytes32"},
          {name: "maker", type: "uint256"},
          {name: "taker", type: "uint256"},
          {name: "token", type: "uint256"},
          {name: "amount", type: "uint256"},
          {name: "safetyDeposit", type: "uint256"},
          {name: "timelocks", type: "uint256"},
          {name: "parameters", type: "bytes"},
        ],
      },
    ],
    outputs: [{name: "escrow", type: "address"}],
  },
] as const;

const FACTORY_ABI = [{
  type: "function", name: "FACTORY", stateMutability: "view", inputs: [], outputs: [{type: "address"}],
}] as const;
const BALANCE_OF_ABI = [{
  type: "function", name: "balanceOf", stateMutability: "view", inputs: [{name: "account", type: "address"}], outputs: [{type: "uint256"}],
}] as const;

// Address is a uint256 user-defined value type in the 1inch factory ABI.
const DST_ESCROW_CREATED_TOPIC = keccak256(stringToHex("DstEscrowCreated(address,bytes32,uint256)"));
const UINT32_MASK = (1n << 32n) - 1n;
const DEPLOYED_AT_OFFSET = 224n;
const DEPLOYED_AT_MASK = UINT32_MASK << DEPLOYED_AT_OFFSET;
const ADDRESS_MASK = (1n << 160n) - 1n;

/** Public fallback endpoints only; deployments pass their own via `rpcUrls`. */
const DEFAULT_RPC_URLS: Readonly<Record<string, readonly string[]>> = {
  "eip155:1": ["https://ethereum-rpc.publicnode.com"],
  "eip155:56": ["https://bsc-rpc.publicnode.com"],
  "eip155:137": ["https://polygon-bor-rpc.publicnode.com"],
  "eip155:4663": ["https://rpc.mainnet.chain.robinhood.com"],
  "eip155:8453": ["https://base-rpc.publicnode.com"],
  "eip155:42161": ["https://arbitrum-one-rpc.publicnode.com"],
  "eip155:43114": ["https://avalanche-c-chain-rpc.publicnode.com"],
  "eip155:196": ["https://rpc.xlayer.tech"],
  "eip155:999": ["https://rpc.hyperliquid.xyz/evm"],
  "eip155:9745": ["https://rpc.plasma.to"],
};

/** How far back (blocks) a factory event is searched, per chain — shared with the EVM input validator. */
export const OMNISTON_EVM_LOOKBACK_BLOCKS: Readonly<Record<string, bigint>> = {
  "eip155:1": 3_000n,
  "eip155:56": 40_000n,
  "eip155:137": 20_000n,
  "eip155:4663": 100_000n,
  "eip155:8453": 20_000n,
  "eip155:42161": 100_000n,
  "eip155:43114": 20_000n,
  // ~1 s blocks (measured 2026-10-20): ~11 h, past the 6 h quote horizon.
  "eip155:196": 40_000n,
  "eip155:999": 40_000n,
  "eip155:9745": 40_000n,
};

/** Confirmations before a factory event counts as final, per chain. */
export const OMNISTON_EVM_MIN_CONFIRMATIONS: Readonly<Record<string, bigint>> = {
  "eip155:1": 2n,
  "eip155:56": 5n,
  "eip155:137": 20n,
  "eip155:4663": 20n,
  "eip155:8453": 20n,
  "eip155:42161": 20n,
  "eip155:43114": 5n,
  "eip155:196": 20n, // sequencer rollup
  "eip155:999": 5n, // HyperBFT, fast finality
  "eip155:9745": 5n, // PlasmaBFT, fast finality
};

export type OmnistonRpcRequest = (chain: string, method: string, params: unknown[]) => Promise<unknown>;
/** CAIP-2 chain → JSON-RPC URLs, tried in order before the public fallbacks. */
export type OmnistonRpcUrls = Readonly<Record<string, readonly string[]>>;
type RpcRequest = OmnistonRpcRequest;

export interface EvmOutputValidationInput {
  chain: string;
  positionAddress: string;
  factoryAddress: string;
  quoteTimestamp: number;
  executionIndex: number;
  recipientAddress: string;
  outputTokenAddress: string;
  inputUnits: string;
  outputUnits: string;
  resolverSendsUnits: string;
  srcHtlcSecurityDepositUnits: string;
  dstSecurityDepositUnits: string;
  protocolFeeUnits: string;
  integratorFeeUnits: string;
  integratorAddress?: string;
  secretHash: Uint8Array;
}

interface RpcLog {
  data: Hex;
  transactionHash: Hex;
  blockNumber: Hex;
}

interface RpcTransaction {
  to: string;
  input: Hex;
  value: Hex;
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

/** JSON-RPC over the caller's endpoints (`rpcUrls`) with public failover (reads only). */
export async function omnistonEvmRpcRequest(chain: string, method: string, params: unknown[], rpcUrls?: OmnistonRpcUrls): Promise<unknown> {
  const urls = [...(rpcUrls?.[chain] ?? []), ...(DEFAULT_RPC_URLS[chain] ?? [])].filter((url): url is string => !!url);
  if (!urls.length) throw new Error(`omniston: no RPC configured for ${chain}`);
  let lastError: unknown;
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as {result?: unknown; error?: unknown};
      if (body.error !== undefined || body.result === undefined) throw new Error("invalid JSON-RPC response");
      return body.result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`omniston: RPC failed for ${chain}`);
}

async function ethCall(request: RpcRequest, chain: string, to: string, data: Hex): Promise<Hex> {
  return await request(chain, "eth_call", [{to, data}, "latest"]) as Hex;
}

/**
 * Builds the mandatory disclosure verifier for TON-source Omniston orders.
 * The feed supplies an address only; this routine proves the actual finalized
 * factory transaction and deterministic escrow before the secret can leave.
 */

/**
 * Find the escrow immutables inside a resolver's calldata.
 *
 * The tuple is ABI-encoded wherever it is passed, so anchoring on the 32-byte
 * hashlock (word 1 of the tuple) yields the static words at fixed offsets and
 * the `parameters` bytes through the tuple's own offset word. What is found
 * here is only a CANDIDATE: the caller proves it by deriving the escrow address
 * from it through the trusted factory (CREATE2 over the immutables), so a
 * decoy tuple planted in the calldata cannot pass.
 */
function locateImmutables(input: Hex, secretHash: Hex): {
  orderHash: Hex;
  hashlock: Hex;
  maker: bigint;
  taker: bigint;
  token: bigint;
  amount: bigint;
  safetyDeposit: bigint;
  timelocks: bigint;
  parameters: Hex;
} | null {
  const data = input.slice(2).toLowerCase();
  const needle = secretHash.slice(2).toLowerCase();
  const at = data.indexOf(needle);
  // Must be word-aligned, preceded by orderHash and followed by seven words.
  if (at < 72 || (at - 8) % 64 !== 0 || data.length < at + 64 * 8) return null;
  const start = at - 64;
  const word = (i: number): bigint => BigInt(`0x${data.slice(at + 64 * i, at + 64 * (i + 1))}`);
  try {
    const offset = word(7);
    if (offset % 32n !== 0n || offset < 288n || offset > 4096n) return null;
    const lengthAt = start + Number(offset) * 2;
    if (data.length < lengthAt + 64) return null;
    const length = BigInt(`0x${data.slice(lengthAt, lengthAt + 64)}`);
    if (length > 1024n || data.length < lengthAt + 64 + Number(length) * 2) return null;
    return {
      orderHash: `0x${data.slice(start, at)}`,
      hashlock: `0x${needle}`,
      maker: word(1), taker: word(2), token: word(3), amount: word(4), safetyDeposit: word(5), timelocks: word(6),
      parameters: `0x${data.slice(lengthAt + 64, lengthAt + 64 + Number(length) * 2)}`,
    };
  } catch {
    return null;
  }
}

export function createOmnistonEvmOutputValidator(options: {request?: RpcRequest; rpcUrls?: OmnistonRpcUrls; now?: () => number} = {}) {
  const request: RpcRequest = options.request ?? ((chain, method, params) => omnistonEvmRpcRequest(chain, method, params, options.rpcUrls));
  const now = options.now ?? Date.now;
  return async (input: EvmOutputValidationInput): Promise<boolean> => {
    try {
      if (
        !OMNISTON_EVM_LOOKBACK_BLOCKS[input.chain] || input.executionIndex !== 0 ||
        !isAddress(input.positionAddress) || !isAddress(input.factoryAddress) ||
        !isAddress(input.recipientAddress) || !isAddress(input.outputTokenAddress) ||
        !Number.isInteger(input.quoteTimestamp) || input.quoteTimestamp * 1000 > now() + 120_000 ||
        now() - input.quoteTimestamp * 1000 > 6 * 60 * 60 * 1000
      ) return false;

      const position = getAddress(input.positionAddress);
      const factory = getAddress(input.factoryAddress);
      const recipient = getAddress(input.recipientAddress);
      const token = getAddress(input.outputTokenAddress);
      const secretHash = bytesHex(input.secretHash);
      const outputUnits = BigInt(input.outputUnits);
      const resolverSendsUnits = BigInt(input.resolverSendsUnits);
      const protocolFeeUnits = BigInt(input.protocolFeeUnits);
      const integratorFeeUnits = BigInt(input.integratorFeeUnits);
      const dstDeposit = BigInt(input.dstSecurityDepositUnits);
      if (
        BigInt(input.inputUnits) <= 0n || outputUnits <= 0n || dstDeposit <= 0n ||
        resolverSendsUnits !== outputUnits + protocolFeeUnits + integratorFeeUnits ||
        input.secretHash.length !== 32
      ) return false;

      const latest = BigInt(await request(input.chain, "eth_blockNumber", []) as string);
      const minConfirmations = OMNISTON_EVM_MIN_CONFIRMATIONS[input.chain] ?? 20n;
      const newestFinal = latest >= minConfirmations ? latest - minConfirmations : 0n;
      const oldest = newestFinal > OMNISTON_EVM_LOOKBACK_BLOCKS[input.chain]!
        ? newestFinal - OMNISTON_EVM_LOOKBACK_BLOCKS[input.chain]!
        : 0n;
      let matchingLog: RpcLog | undefined;
      for (let to = newestFinal; to >= oldest && !matchingLog;) {
        const from = to - oldest > 4_999n ? to - 4_999n : oldest;
        const logs = await request(input.chain, "eth_getLogs", [{
          address: factory,
          topics: [DST_ESCROW_CREATED_TOPIC],
          fromBlock: quantity(from),
          toBlock: quantity(to),
        }]) as RpcLog[];
        matchingLog = logs.find((log) => {
          try {
            const [escrow, hashlock] = decodeAbiParameters(
              [{type: "address"}, {type: "bytes32"}, {type: "uint256"}],
              log.data,
            );
            return getAddress(escrow) === position && hashlock.toLowerCase() === secretHash.toLowerCase();
          } catch {
            return false;
          }
        });
        if (from === oldest) break;
        to = from - 1n;
      }
      if (!matchingLog) return false;

      const [transaction, receipt, block, code] = await Promise.all([
        request(input.chain, "eth_getTransactionByHash", [matchingLog.transactionHash]) as Promise<RpcTransaction | null>,
        request(input.chain, "eth_getTransactionReceipt", [matchingLog.transactionHash]) as Promise<{status: Hex; blockNumber: Hex} | null>,
        request(input.chain, "eth_getBlockByNumber", [matchingLog.blockNumber, false]) as Promise<{timestamp: Hex} | null>,
        request(input.chain, "eth_getCode", [position, "latest"]) as Promise<Hex>,
      ]);
      if (
        !transaction || !receipt || !block || !code || code === "0x" || receipt.status !== "0x1" ||
        BigInt(receipt.blockNumber) !== BigInt(matchingLog.blockNumber) ||
        latest - BigInt(receipt.blockNumber) < minConfirmations ||
        BigInt(block.timestamp) + 120n < BigInt(input.quoteTimestamp)
      ) return false;

      // Resolvers deploy the destination escrow through their OWN contract, not
      // by calling the factory directly: the observed transaction targets the
      // resolver, carries its private selector and sends no value, while the
      // factory only emits the event. Reconstructing `createDstEscrow` from that
      // calldata therefore never matches, which silently blocked every
      // disclosure. What the trader actually needs is provable without it: an
      // escrow the TRUSTED factory announced for THIS hashlock, deployed, and
      // already holding the promised output.
      //
      // The immutables still ride through that calldata as a contiguous ABI
      // tuple, so when the hashlock can be located we verify the fields that
      // decide who gets paid, and a contradiction is fatal. When the wrapper
      // hides them, the on-chain evidence below still has to hold.
      // Fail closed: the immutables decide who gets paid, so they must be
      // found AND proven to be this escrow's — the factory derives the escrow
      // address from them (deployedAt is stamped with the deployment block's
      // timestamp before the CREATE2 salt is taken). Seen live on Base
      // 2026-10-20 for every Omniston destination escrow.
      const immutables = locateImmutables(transaction.input, secretHash);
      if (!immutables) return false;
      const stamped = {...immutables, timelocks: (immutables.timelocks & ~DEPLOYED_AT_MASK) | (BigInt(block.timestamp) << DEPLOYED_AT_OFFSET)};
      const derived = decodeFunctionResult({
        abi: ESCROW_FACTORY_ABI,
        functionName: "addressOfEscrowDst",
        data: await ethCall(request, input.chain, factory, encodeFunctionData({abi: ESCROW_FACTORY_ABI, functionName: "addressOfEscrowDst", args: [stamped]})),
      });
      if (getAddress(derived) !== position) return false;
      if (!(
        uintAddress(immutables.maker) === recipient &&
        uintAddress(immutables.token) === token &&
        immutables.amount === resolverSendsUnits &&
        immutables.safetyDeposit === dstDeposit
      )) return false;

      const [reportedFactory, tokenBalance, nativeBalance] = await Promise.all([
        ethCall(request, input.chain, position, encodeFunctionData({abi: FACTORY_ABI, functionName: "FACTORY"}))
          .then((data) => decodeFunctionResult({abi: FACTORY_ABI, functionName: "FACTORY", data})),
        ethCall(request, input.chain, token, encodeFunctionData({abi: BALANCE_OF_ABI, functionName: "balanceOf", args: [position]}))
          .then((data) => decodeFunctionResult({abi: BALANCE_OF_ABI, functionName: "balanceOf", data})),
        request(input.chain, "eth_getBalance", [position, "latest"]) as Promise<Hex>,
      ]);
      // The escrow points back at the trusted factory, holds the output the
      // resolver promised, and carries its own safety deposit — none of which a
      // resolver can fake by merely reporting a phase.
      return getAddress(reportedFactory) === factory &&
        tokenBalance >= resolverSendsUnits &&
        BigInt(nativeBalance) >= dstDeposit;
    } catch {
      return false;
    }
  };
}

// A fake JSON-RPC per USDT0 chain + a fake LayerZero Scan behind one fetch, shared by the provider and pin tests.
import {decodeFunctionData, encodeFunctionResult, getAddress, pad, parseAbi, toHex, type Hex} from "viem";
import {usdt0Provider} from "../src/provider.js";
import {USDT0_CHAINS, USDT0_BY_EID} from "../src/config.js";

export const ARB = USDT0_CHAINS["eip155:42161"]!;
export const ETH = USDT0_CHAINS["eip155:1"]!;
export const HYPE = USDT0_CHAINS["eip155:999"]!;
export const OP = USDT0_CHAINS["eip155:10"]!;
export const SENDER = "0x4444444444444444444444444444444444444444";
export const RECIPIENT = "0x3333333333333333333333333333333333333333";
export const SRC_TX = "0x" + "ab".repeat(32);
export const GUID = ("0x" + "11".repeat(32)) as Hex;
export const PAYLOAD = ("0x" + "00".repeat(12) + RECIPIENT.slice(2) + "0000000000989680") as Hex; // to(32) + amountSD(8) = 10 USDT
export const FEE = 6_248_183_276_938n; // live quoteSend Arbitrum → HyperEVM, 10 USDT, 2026-10-20
/** What the quote seals: FEE + 25 % headroom (the endpoint refunds the unused part). */
export const SEALED = FEE + (FEE * 2_500n) / 10_000n;

export const OFT_ABI = parseAbi([
  "struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD; bytes extraOptions; bytes composeMsg; bytes oftCmd; }",
  "struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }",
  "struct OFTLimit { uint256 minAmountLD; uint256 maxAmountLD; }",
  "struct OFTFeeDetail { int256 feeAmountLD; string description; }",
  "struct OFTReceipt { uint256 amountSentLD; uint256 amountReceivedLD; }",
  "struct MessagingReceipt { bytes32 guid; uint64 nonce; MessagingFee fee; }",
  "function quoteSend(SendParam s, bool payInLzToken) view returns (MessagingFee)",
  "function quoteOFT(SendParam s) view returns (OFTLimit, OFTFeeDetail[], OFTReceipt)",
  "function send(SendParam s, MessagingFee fee, address refundAddress) payable returns (MessagingReceipt, OFTReceipt)",
  "function token() view returns (address)",
  "function approvalRequired() view returns (bool)",
  "function peers(uint32 eid) view returns (bytes32)",
]);
export const ENDPOINT_ABI = parseAbi([
  "struct Origin { uint32 srcEid; bytes32 sender; uint64 nonce; }",
  "function lzReceive(Origin origin, address receiver, bytes32 guid, bytes message, bytes extraData) payable",
]);

export const PARAMS = {sourceChain: "eip155:42161", sourceToken: "USDT0", destChain: "eip155:999", destToken: HYPE.token, amountIn: "10000000", destAddress: RECIPIENT, refundAddress: SENDER, slippageBps: 0};

export interface World {
  /** amountReceivedLD the OFT reports (default = amount). */
  received?: (amount: bigint) => bigint;
  minAmount?: bigint; maxAmount?: bigint;
  fee?: bigint; lzTokenFee?: bigint;
  feeDetails?: {feeAmountLD: bigint; description: string}[];
  token?: string; approvalRequired?: boolean; peer?: Hex | null;
  message?: unknown; scanStatus?: number;
}

/** Fake JSON-RPC (one URL per chain) + fake LayerZero Scan behind one fetch. */
export function world(o: World = {}) {
  const calls: string[] = [];
  const chainOf = (url: string) => url.includes("rpc.arb") ? ARB : url.includes("rpc.eth") ? ETH : url.includes("rpc.hype") ? HYPE : OP;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.startsWith("https://scan.test")) {
      if (o.scanStatus) return new Response("", {status: o.scanStatus});
      return o.message === undefined ? new Response(JSON.stringify({message: "Message not found", code: 4040}), {status: 404}) : new Response(JSON.stringify({data: [o.message]}));
    }
    if (url.startsWith("http://rpc.")) {
      const chain = chainOf(url);
      const body = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]};
      const reply = (result: unknown) => new Response(JSON.stringify({jsonrpc: "2.0", id: body.id, result}));
      if (body.method === "eth_chainId") return reply(toHex(chain.chainId));
      if (body.method === "eth_call") {
        const {to, data} = (body.params as [{to: string; data: Hex}])[0];
        if (to.toLowerCase() !== chain.oft.toLowerCase()) return new Response(JSON.stringify({jsonrpc: "2.0", id: body.id, error: {code: 3, message: "execution reverted"}}));
        const {functionName, args} = decodeFunctionData({abi: OFT_ABI, data});
        const enc = (result: unknown) => reply(encodeFunctionResult({abi: OFT_ABI, functionName, result} as never));
        if (functionName === "token") return enc(o.token ?? chain.token);
        if (functionName === "approvalRequired") return enc(o.approvalRequired ?? chain.adapter);
        if (functionName === "peers") {
          const dst = USDT0_BY_EID[Number((args as [number])[0])];
          return enc(o.peer === null ? "0x" + "00".repeat(32) : o.peer ?? (dst ? pad(getAddress(dst.oft), {size: 32}) : "0x" + "00".repeat(32)));
        }
        const sp = (args as unknown as [{amountLD: bigint; minAmountLD: bigint}])[0];
        if (functionName === "quoteOFT") {
          const recv = (o.received ?? ((a: bigint) => a))(sp.amountLD);
          return enc([{minAmountLD: o.minAmount ?? 0n, maxAmountLD: o.maxAmount ?? 2n ** 64n - 1n}, o.feeDetails ?? [], {amountSentLD: sp.amountLD, amountReceivedLD: recv}]);
        }
        if (functionName === "quoteSend") return enc({nativeFee: o.fee ?? FEE, lzTokenFee: o.lzTokenFee ?? 0n});
      }
      return new Response(JSON.stringify({jsonrpc: "2.0", id: body.id, error: {code: -32601, message: body.method}}));
    }
    return new Response("", {status: 404});
  }) as typeof fetch;
  return {fetchImpl, calls};
}

export const RPC = {"eip155:42161": "http://rpc.arb", "eip155:1": "http://rpc.eth", "eip155:999": "http://rpc.hype", "eip155:10": ["http://rpc.op", "http://rpc.op2"]};
export const make = (o: World = {}, cfg: Record<string, unknown> = {}) => {
  const w = world(o);
  const p = usdt0Provider({scanUrl: "https://scan.test", fetchImpl: w.fetchImpl, rpcUrls: RPC, ...cfg});
  return {...w, p};
};

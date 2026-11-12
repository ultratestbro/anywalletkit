// Shared by the Legacy Mesh tests: a fake JSON-RPC per mesh source, a fake LayerZero Scan and a fake tonapi behind one
// fetch; the pinned real recipient vectors.
import {decodeFunctionData, encodeErrorResult, encodeFunctionResult, parseAbi, toHex, type Hex} from "viem";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {usdt0Provider} from "../src/provider.js";
import {USDT0_MESH_DESTINATIONS, USDT0_MESH_SOURCES} from "../src/config.js";

export const ETH = USDT0_MESH_SOURCES["eip155:1"]!;
export const ARB = USDT0_MESH_SOURCES["eip155:42161"]!;
export const CELO = USDT0_MESH_SOURCES["eip155:42220"]!;
export const TRON = USDT0_MESH_DESTINATIONS["tron:728126428"]!;
export const TON = USDT0_MESH_DESTINATIONS["ton:-239"]!;
export const SENDER = "0x4444444444444444444444444444444444444444";
export const ATTACKER = "0x9999999999999999999999999999999999999999";
export const SRC_TX = "0x" + "cd".repeat(32);
export const DST_TX = "0x" + "ef".repeat(32);

// Real vectors (LayerZero Scan packets 2026-11-12 and the payouts the destination made):
//  - Ethereum → Tron, src 0x458c5542…f51c: packet `to` = 0x…ace3e328…2727; TronGrid: USDT from the Tron OFT to TRjNDwg9….
//  - Arbitrum → TON, src 0xa2a27a81…8411: packet `to` = 0x10b245cc…2ace; toncenter: the USDT jetton from the TON OFT to
//    UQAQskXM…zp5R (0:10b245cc…2ace), 975.094748 USDT = the packet's amount.
export const TRON_TO = "TRjNDwg9kSj7sv1J6qGG4ad2wB9S9XqjMn";
export const TRON_TO_B32 = "0x000000000000000000000000ace3e3286b7692028204857bd539c82517372727";
export const TON_TO = "UQAQskXMoOIlwQZWQaqDmfRsNQaYsyTE5ImQoZ2QMCMqzp5R";
export const TON_TO_RAW = "0:10b245cca0e225c1065641aa8399f46c350698b324c4e48990a19d9030232ace";
export const TON_TO_B32 = "0x10b245cca0e225c1065641aa8399f46c350698b324c4e48990a19d9030232ace";
/** quoteSend live 2026-11-12: Arbitrum → Tron 0.00534 ETH, Arbitrum → TON 0.0000563 ETH (no headroom). */
export const FEE_TRON = 5_340_790_637_607_643n;
export const FEE_TON = 56_287_292_611_713n;
export const sealedOf = (fee: bigint) => fee + (fee * 2_500n) / 10_000n;
export const recvOf = (amount: bigint) => amount - (amount * 3n) / 10_000n;

export const ABI = parseAbi([
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
  "error InsufficientCredits(uint32 eid, uint256 credits, uint256 amountWithdraw)",
]);

export interface MeshWorld {
  token?: string; approvalRequired?: boolean; peer?: Hex;
  credits?: bigint; fee?: bigint; lzTokenFee?: bigint;
  /** quoteSend: "credits" reverts with InsufficientCredits, "http" answers 500. */
  quoteSendFails?: "credits" | "http";
  message?: unknown; scanStatus?: number;
  tonEvent?: unknown; tonStatus?: number;
}

export const RPC = {"eip155:1": "http://rpc.eth", "eip155:42161": "http://rpc.arb", "eip155:42220": "http://rpc.celo"};

export function meshWorld(o: MeshWorld = {}) {
  const calls: string[] = [];
  const srcOf = (url: string) => url.includes("rpc.eth") ? ETH : url.includes("rpc.celo") ? CELO : ARB;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.startsWith("https://scan.test")) {
      if (o.scanStatus) return new Response("", {status: o.scanStatus});
      return o.message === undefined ? new Response(JSON.stringify({message: "Message not found"}), {status: 404}) : new Response(JSON.stringify({data: [o.message]}));
    }
    if (url.startsWith("https://ton.test")) {
      if (o.tonStatus) return new Response("", {status: o.tonStatus});
      return new Response(JSON.stringify(o.tonEvent ?? {}));
    }
    if (url.startsWith("http://rpc.")) {
      const src = srcOf(url);
      const body = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]};
      const reply = (result: unknown) => new Response(JSON.stringify({jsonrpc: "2.0", id: body.id, result}));
      if (body.method === "eth_chainId") return reply(toHex(src.chainId));
      if (body.method === "eth_call") {
        const {to, data} = (body.params as [{to: string; data: Hex}])[0];
        if (to.toLowerCase() !== src.oft.toLowerCase()) return new Response(JSON.stringify({jsonrpc: "2.0", id: body.id, error: {code: 3, message: "execution reverted"}}));
        const {functionName, args} = decodeFunctionData({abi: ABI, data});
        const enc = (result: unknown) => reply(encodeFunctionResult({abi: ABI, functionName, result} as never));
        if (functionName === "token") return enc(o.token ?? src.token);
        if (functionName === "approvalRequired") return enc(o.approvalRequired ?? true);
        if (functionName === "peers") {
          const eid = Number((args as [number])[0]);
          const dst = Object.values(USDT0_MESH_DESTINATIONS).find((d) => d.eid === eid);
          return enc(o.peer ?? dst?.peer ?? "0x" + "00".repeat(32));
        }
        const sp = (args as unknown as [{dstEid: number; amountLD: bigint; minAmountLD: bigint}])[0];
        if (functionName === "quoteOFT") return enc([{minAmountLD: 0n, maxAmountLD: o.credits ?? 10n ** 13n}, [], {amountSentLD: sp.amountLD, amountReceivedLD: recvOf(sp.amountLD)}]);
        if (functionName === "quoteSend") {
          if (o.quoteSendFails === "http") return new Response("upstream", {status: 500});
          if (o.quoteSendFails === "credits") {
            const err = encodeErrorResult({abi: ABI, errorName: "InsufficientCredits", args: [sp.dstEid, 5n, recvOf(sp.amountLD)]});
            return new Response(JSON.stringify({jsonrpc: "2.0", id: body.id, error: {code: 3, message: "execution reverted", data: err}}));
          }
          return enc({nativeFee: o.fee ?? (sp.dstEid === TRON.eid ? FEE_TRON : FEE_TON), lzTokenFee: o.lzTokenFee ?? 0n});
        }
      }
      return new Response(JSON.stringify({jsonrpc: "2.0", id: body.id, error: {code: -32601, message: body.method}}));
    }
    return new Response("", {status: 404});
  }) as typeof fetch;
  return {fetchImpl, calls};
}

export const make = (o: MeshWorld = {}, cfg: Record<string, unknown> = {}) => {
  const w = meshWorld(o);
  return {...w, p: usdt0Provider({scanUrl: "https://scan.test", tonApiUrl: "https://ton.test", fetchImpl: w.fetchImpl, rpcUrls: RPC, ...cfg})};
};

export const TO_TRON: QuoteParams = {sourceChain: "eip155:42161", sourceToken: "USDT0", destChain: "tron:728126428", destToken: "USDT", amountIn: "10000000", destAddress: TRON_TO, refundAddress: SENDER, dry: false};
export const TO_TON: QuoteParams = {...TO_TRON, destChain: "ton:-239", destToken: TON.token, destAddress: TON_TO};

export async function quote(params: Partial<QuoteParams> = {}, o: MeshWorld = {}, base: QuoteParams = TO_TRON) {
  const reasons: string[] = [];
  const {p, calls} = make(o);
  const q = await p.getQuote({...base, ...params, onRefusal: (r) => reasons.push(r)});
  return {q, reasons, p, calls};
}

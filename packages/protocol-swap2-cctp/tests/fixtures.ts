// A fake Circle API + JSON-RPC for the Base and Arbitrum domains, shared by the provider and corridor tests.
import {decodeFunctionData, encodeFunctionResult, parseAbi, toHex, type Hex} from "viem";
import {cctpProvider} from "../src/provider.js";
import {MESSAGE_TRANSMITTER_V2, TOKEN_MESSENGER_V2} from "../src/config.js";

export const MESSENGER_ABI = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
  "function getMinFeeAmount(uint256 amount) view returns (uint256)",
  "function localMessageTransmitter() view returns (address)",
]);
export const TRANSMITTER_ABI = parseAbi([
  "function receiveMessage(bytes message, bytes attestation) returns (bool)",
  "function localDomain() view returns (uint32)",
  "function usedNonces(bytes32 nonce) view returns (uint256)",
]);

/** Fake Circle API + fake JSON-RPC behind one fetch. */
export function world(o: {fees?: unknown; allowance?: number; message?: unknown; usedNonce?: bigint; domain?: number; transmitter?: string; head?: bigint; l1Head?: bigint} = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.startsWith("https://iris.test")) {
      const path = url.slice("https://iris.test".length);
      if (path.startsWith("/v2/burn/USDC/fees/")) return new Response(JSON.stringify(o.fees ?? [{finalityThreshold: 1000, minimumFee: 1.3}, {finalityThreshold: 2000, minimumFee: 0}]));
      if (path.startsWith("/v2/fastBurn/USDC/allowance")) return new Response(JSON.stringify({allowance: o.allowance ?? 1_000_000}));
      if (path.startsWith("/v2/messages/")) return o.message === undefined ? new Response("", {status: 404}) : new Response(JSON.stringify({messages: [o.message]}));
      if (path.startsWith("/v2/reattest/")) return new Response(JSON.stringify({}));
      return new Response("", {status: 500});
    }
    if (url.startsWith("http://rpc.")) {
      const body = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]};
      const reply = (result: unknown) => new Response(JSON.stringify({jsonrpc: "2.0", id: body.id, result}));
      if (body.method === "eth_chainId") return reply(url.includes("base") ? "0x2105" : "0xa4b1");
      if (body.method === "eth_blockNumber") return reply(toHex(o.head ?? 100n));
      if (body.method === "eth_getBlockByNumber") return reply({number: toHex(o.head ?? 100n), ...(o.l1Head !== undefined ? {l1BlockNumber: toHex(o.l1Head)} : {})});
      if (body.method === "eth_call") {
        const {to, data} = (body.params as [{to: string; data: Hex}])[0];
        const abi = to.toLowerCase() === TOKEN_MESSENGER_V2.toLowerCase() ? MESSENGER_ABI : TRANSMITTER_ABI;
        const {functionName} = decodeFunctionData({abi, data});
        // Like the deployed TokenMessengerV2 (2026-10-12): no on-chain minimum fee.
        if (functionName === "getMinFeeAmount") return new Response(JSON.stringify({jsonrpc: "2.0", id: body.id, error: {code: 3, message: "execution reverted"}}));
        const result =
          functionName === "localMessageTransmitter" ? (o.transmitter ?? MESSAGE_TRANSMITTER_V2)
          : functionName === "localDomain" ? (o.domain ?? 6)
          : functionName === "usedNonces" ? (o.usedNonce ?? 0n)
          : 0n;
        return reply(encodeFunctionResult({abi, functionName, result} as never));
      }
      return new Response(JSON.stringify({jsonrpc: "2.0", id: body.id, error: {code: -32601, message: body.method}}));
    }
    return new Response("", {status: 404});
  }) as typeof fetch;
  return {fetchImpl, calls};
}

export const make = (o: Parameters<typeof world>[0] = {}, cfg: Record<string, unknown> = {}) => {
  const w = world(o);
  const p = cctpProvider({apiUrl: "https://iris.test", fetchImpl: w.fetchImpl, rpcUrls: {"eip155:8453": "http://rpc.base", "eip155:42161": "http://rpc.arb"}, ...cfg});
  return {...w, p};
};

import {createPublicClient, fallback, http, pad, parseAbi, type Address, type Hex, type PublicClient} from "viem";
import {STARGATE_ABI, TOKEN_MESSAGING_ABI} from "./abi.js";
import type {StargateDeployment} from "./registry.js";

export class StargateReadError extends Error {
  constructor(message: string) { super(`stargate: ${message}`); this.name = "StargateReadError"; }
}

export interface StargateRpcConfig {
  /** Both source and destination RPCs are required. URLs are never included in errors. */
  rpcUrls: Readonly<Record<string, string | readonly string[]>>;
  fetchImpl?: typeof fetch;
}
export interface StargateBlock {readonly number: bigint; readonly hash: Hex; readonly timestamp: bigint}
export interface StargateRpc {
  has(chain: string): boolean;
  client(chain: string, signal?: AbortSignal): PublicClient;
  snapshot(client: PublicClient, chainId: number): Promise<StargateBlock>;
  verify(client: PublicClient, deployment: StargateDeployment, peer: StargateDeployment, block: StargateBlock): Promise<void>;
  unchanged(client: PublicClient, block: StargateBlock): Promise<void>;
}
const auxiliaryAbi = parseAbi(["function decimals() view returns (uint8)", "function eid() view returns (uint32)"]);
export const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
export function assertStargate(condition: unknown, message: string): asserts condition {
  if (!condition) throw new StargateReadError(message);
}
export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StargateReadError("request cancelled");
}

/** No mutable deployment/peer/paused-state cache: every quote verifies a fresh snapshot. */
export function stargateRpc(config: StargateRpcConfig): StargateRpc {
  const urls = new Map(Object.entries(config.rpcUrls).map(([chain, value]) => {
    const list = typeof value === "string" ? [value] : [...value];
    assertStargate(list.length && list.every((url) => /^https?:\/\//.test(url)), "invalid RPC configuration");
    return [chain, list] as const;
  }));
  function client(chain: string, signal?: AbortSignal): PublicClient {
    const list = urls.get(chain);
    assertStargate(list, `no RPC configured for ${chain}`);
    assertNotAborted(signal);
    const transport = (url: string) => http(url, {timeout: 12_000, retryCount: 0, ...(config.fetchImpl ? {fetchFn: config.fetchImpl} : {}), ...(signal ? {fetchOptions: {signal}} : {})});
    return createPublicClient({transport: list.length === 1 ? transport(list[0]!) : fallback(list.map(transport), {retryCount: 0}), ccipRead: false});
  }
  type Client = ReturnType<typeof client>;
  async function snapshot(c: Client, chainId: number): Promise<StargateBlock> {
    const [actual, block] = await Promise.all([c.getChainId(), c.getBlock({blockTag: "latest"})]);
    assertStargate(actual === chainId, "RPC chain id mismatch");
    assertStargate(block.hash && block.number !== null, "RPC returned an unmined block");
    // Stale nodes must not turn old fees/credits into a new, apparently fresh quote.
    const now = BigInt(Math.floor(Date.now() / 1000));
    assertStargate(block.timestamp >= now - 300n && block.timestamp <= now + 60n, "RPC block is stale or in the future");
    return Object.freeze({number: block.number, hash: block.hash, timestamp: block.timestamp});
  }
  async function verify(c: Client, d: StargateDeployment, peer: StargateDeployment, block: StargateBlock): Promise<void> {
    const at = {blockNumber: block.number};
    const pool = {address: d.address, abi: STARGATE_ABI, ...at};
    const messaging = {address: d.tokenMessaging, abi: TOKEN_MESSAGING_ABI, ...at};
    const [token, shared, approval, eid, endpoint, status, kind, roles, assetId, implementation, messagingEndpoint, remotePeer, endpointEid, decimals] = await Promise.all([
      c.readContract({...pool, functionName: "token"}),
      c.readContract({...pool, functionName: "sharedDecimals"}),
      c.readContract({...pool, functionName: "approvalRequired"}),
      c.readContract({...pool, functionName: "localEid"}),
      c.readContract({...pool, functionName: "endpoint"}),
      c.readContract({...pool, functionName: "status"}),
      c.readContract({...pool, functionName: "stargateType"}),
      c.readContract({...pool, functionName: "getAddressConfig"}),
      c.readContract({...messaging, functionName: "assetIds", args: [d.address]}),
      c.readContract({...messaging, functionName: "stargateImpls", args: [d.assetId]}),
      c.readContract({...messaging, functionName: "endpoint"}),
      c.readContract({...messaging, functionName: "peers", args: [peer.eid]}),
      c.readContract({address: d.endpoint, abi: auxiliaryAbi, functionName: "eid", ...at}),
      d.kind === "native" ? Promise.resolve(d.localDecimals) : c.readContract({address: d.token, abi: auxiliaryAbi, functionName: "decimals", ...at}),
    ]);
    assertStargate(sameAddress(token, d.token) && shared === d.sharedDecimals && decimals === d.localDecimals && approval === d.approvalRequired && eid === d.eid && endpointEid === d.eid && sameAddress(endpoint, d.endpoint) && sameAddress(messagingEndpoint, d.endpoint) && sameAddress(roles.tokenMessaging, d.tokenMessaging) && assetId === d.assetId && sameAddress(implementation, d.address) && kind === (d.kind === "oft" ? 1 : 0), `deployment identity changed on ${d.chain}`);
    assertStargate(status === 1, `deployment is not active on ${d.chain}`);
    assertStargate(sameAddress(remotePeer, pad(peer.tokenMessaging, {size: 32})), `messaging peer mismatch on ${d.chain}`);
  }
  async function unchanged(c: Client, block: StargateBlock): Promise<void> {
    assertStargate((await c.getBlock({blockNumber: block.number})).hash === block.hash, "block changed during quote");
  }
  return {has: (chain: string) => urls.has(chain), client, snapshot, verify, unchanged};
}

/** Never propagate viem errors: they can contain credential-bearing URLs and request bodies. */
export function safeReadError(error: unknown): StargateReadError {
  return error instanceof StargateReadError ? error : new StargateReadError("RPC read, quote or decoding failed");
}

export function nonzeroAddress(value: string): value is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value);
}

/**
 * The attacks of the independent reviews of 2026-11-15 (live acceptance with the real key, the adversarial review of
 * this module and of the core Permit2 path), each built on a REAL 0x answer from fixtures/quotes and turned into a
 * regression test (replayed with the chain table of its pin era, tests/recorded.ts). Threat model: the 0x API, the remote backend and the RPC are hostile; the device must not sign
 * anything that moves more than the input of the input token to anyone but the swap, or delivers the output elsewhere.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import type {ChainTx} from "@anywalletkit/core";
import {describeZeroExActivity} from "../src/activity.js";
import {ZeroExSwap2Protocol} from "../src/protocol.js";
import {zeroExProvider} from "../src/provider.js";
import {zeroExRemoteProvider, zeroExVerifyQuote} from "../src/remote.js";
import {checkZeroExTransaction, createSettlerResolver, decodeSettlerExecute, zeroExSettlerAddress, zeroExSettlerNonce} from "../src/settler.js";
import {executeData, getKey, transferFromAction, uniswapV3VipAction, word, type Permit} from "./fixtures.js";
import {bodyOf, chainIdOf, chainOf, chainsConfigOf, chainsOf, loadRecorded, paramsOf, recordedFetch, rpcOf, type RecordedQuote} from "./recorded.js";

beforeEach(() => { vi.useFakeTimers({toFake: ["Date"]}); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const ATTACKER = "0x5555555555555555555555555555555555555555";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ctxOf = (f: RecordedQuote) => ({chains: chainsOf(f), settlers: () => [f.registry.current, ...(f.registry.prev ? [f.registry.prev] : [])], nowMs: f.request.nowMs});

/** The raw bytes (hex, no 0x) of each action of a Settler call, in order. */
function actionsOf(data: string): string[] {
  const body = data.slice(10).toLowerCase();
  return decodeSettlerExecute(data).actions.map((a) => {
    const start = (a.argsStart - 4) * 2;
    // Action 0 of a token sale declares more than is there (its signature is appended later): cut at the data's end.
    return body.slice(start, Math.min(start + a.declaredLength * 2, body.length));
  });
}
/** The recorded call with action 0 replaced (same recipient, buy token, minimum and route). */
function withFirstAction(f: RecordedQuote, first: string, firstLength?: number): string {
  const data = f.response.transaction.data as string;
  const e = decodeSettlerExecute(data);
  return executeData({recipient: e.recipient, buyToken: e.buyToken, min: e.minAmountOut, first, ...(firstLength ? {firstLength} : {}), later: actionsOf(data).slice(1), zid: e.zidAndAffiliate});
}

describe("probe 1: a native-coin sale spends an earlier, unspent Permit2 signature of this account in its action 0", () => {
  // A permit this account signed for a swap that reverted on-chain: public, its nonce unused, spender = the Settler.
  const f = loadRecorded("base-eth-usdc");
  const stale: Permit = {token: USDC, amount: 5_000_000n, nonce: 123n, deadline: BigInt(Math.floor(f.request.nowMs / 1000) + 200)};
  const inlineSig = `${word(0xc0)}${word(65)}${"ab".repeat(65)}${"00".repeat(31)}`;
  const attacks: [string, string][] = [
    ["TRANSFER_FROM to the attacker", transferFromAction(stale, {recipient: ATTACKER}) + inlineSig],
    ["a UNISWAPV3_VIP pulling the stale permit", uniswapV3VipAction(stale)],
  ];
  for (const [name, first] of attacks) {
    it(`${name}: refused by the device check, in remote and in local mode, before anything is signed`, async () => {
      vi.setSystemTime(f.request.nowMs);
      const data = withFirstAction(f, first, 0xffff);
      // remote mode: the backend's quote, held to the request on the device
      vi.stubGlobal("fetch", recordedFetch(f));
      const honest = await zeroExProvider({apiKey: getKey, rpcUrls: rpcOf(f), chains: chainsConfigOf(f)}).getQuote(paramsOf(f));
      const forged = {...honest!, txRequest: {...honest!.txRequest!, data}};
      expect(zeroExVerifyQuote(paramsOf(f), forged, ctxOf(f))).toMatch(/^the swap's first action 0x[0-9a-f]{8} is not the native-value check a native-coin sale opens with$/);
      // local mode: the API's answer
      const body = bodyOf(f);
      body.transaction.data = data;
      vi.stubGlobal("fetch", recordedFetch(f, {body}));
      const heard: {text: string; reason?: string}[] = [];
      expect(await zeroExProvider({apiKey: getKey, rpcUrls: rpcOf(f), chains: chainsConfigOf(f)}).getQuote(paramsOf(f, {onRefusal: (text, info) => heard.push({text, ...(info ? {reason: info.reason} : {})})}))).toBeNull();
      expect(heard).toEqual([{text: expect.stringMatching(/is not the native-value check a native-coin sale opens with$/), reason: "policy_refused"}]);
    });
  }
  it("the honest recorded native sale (NATIVE_CHECK first) passes", () => {
    const e = decodeSettlerExecute(f.response.transaction.data);
    expect(() => checkZeroExTransaction({to: f.response.transaction.to, data: f.response.transaction.data, value: f.response.transaction.value, chainId: 8453}, {chainId: 8453, chain: chainOf(f), settlers: ctxOf(f).settlers(), sellToken: "0x0000000000000000000000000000000000000000", buyToken: USDC, sellAmount: BigInt(f.request.amountIn), recipient: e.recipient, minBuyAmount: e.minAmountOut, nowMs: f.request.nowMs})).not.toThrow();
  });
});

describe("probe 2: a quoted gas limit far below what the signed call needs (an on-chain revert after the signature is public)", () => {
  it("passes the module's checks but is not what the engine broadcasts with: the account's own estimate is", async () => {
    const f = loadRecorded("base-usdc-eth");
    vi.setSystemTime(f.request.nowMs);
    const body = bodyOf(f);
    body.transaction.gas = "1"; // → gasLimit 20001 after the provider's headroom
    vi.stubGlobal("fetch", recordedFetch(f, {body}));
    const TAKER = f.request.refundAddress;
    const sent: {to?: string; gasLimit?: bigint}[] = [];
    const account = {
      getAddress: async () => TAKER, getChainId: async () => 8453, getBalance: async () => 10n ** 18n, getAllowance: async () => 0n,
      quoteSendTransaction: async () => ({fee: 1n}), waitForTransaction: async () => {}, signTypedData: async () => `0x${"ab".repeat(65)}`,
      sendTransaction: async (t: {to?: string; gasLimit?: bigint}) => { sent.push(t); return {hash: `0x${"1".repeat(64)}`}; },
    };
    await new ZeroExSwap2Protocol(account as never, {fromChain: "eip155:8453", apiKey: getKey, rpcUrls: rpcOf(f), chains: chainsConfigOf(f)})
      .swap2({fromToken: "USDC", toToken: f.request.destToken, toChain: 8453, recipient: TAKER, fromTokenAmount: BigInt(f.request.amountIn), minAmountOut: BigInt(f.response.minBuyAmount), slippageBps: 50} as never);
    expect(sent.at(-1)!.to!.toLowerCase()).toBe(f.response.transaction.to.toLowerCase());
    expect(sent.at(-1)!.gasLimit).toBeUndefined();
  });
});

describe("probe 3: an RPC (in the backend's trust domain) names the attacker as the Settler, and the API quotes it", () => {
  const f = loadRecorded("base-usdc-eth");
  const forge = () => {
    const body = bodyOf(f);
    body.transaction.to = ATTACKER;
    body.permit2.eip712.message.spender = ATTACKER;
    body.permit2.hash = null;
    const permit = body.permit2.eip712.message;
    const first: Permit = {token: permit.permitted.token, amount: BigInt(permit.permitted.amount), nonce: BigInt(permit.nonce), deadline: BigInt(permit.deadline)};
    body.transaction.data = withFirstAction(f, transferFromAction(first, {recipient: ATTACKER, sigOffset: 0xc0}), 0xffff);
    return body;
  };
  it("local mode: the registry answer is not an address the 0x registry deploys to — refused, nothing asked of the API", async () => {
    vi.setSystemTime(f.request.nowMs);
    const seen: {url: string; method: string}[] = [];
    vi.stubGlobal("fetch", recordedFetch(f, {body: forge(), registry: {current: ATTACKER, prev: null}, seen}));
    const heard: {text: string; reason?: string}[] = [];
    expect(await zeroExProvider({apiKey: getKey, rpcUrls: rpcOf(f), chains: chainsConfigOf(f)}).getQuote(paramsOf(f, {onRefusal: (text, info) => heard.push({text, ...(info ? {reason: info.reason} : {})})}))).toBeNull();
    expect(heard).toEqual([{text: `zeroex: the RPC on chain 8453 names ${ATTACKER} as the 0x Settler, which is not an address the 0x registry deploys Settlers to`, reason: "vault_mismatch"}]);
    expect(seen.filter((s) => s.method === "GET")).toEqual([]);
  });
  it("remote mode: the app's own registry read refuses before the backend is asked", async () => {
    vi.setSystemTime(f.request.nowMs);
    vi.stubGlobal("fetch", recordedFetch(f, {registry: {current: ATTACKER, prev: null}}));
    const backend = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    const app = zeroExRemoteProvider({baseUrl: "https://backend.example/api/swap2", fetchImpl: backend, rpcUrls: rpcOf(f), chains: chainsConfigOf(f)});
    const err = await app.getQuote(paramsOf(f)).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/is not an address the 0x registry deploys Settlers to/);
    expect(refusalOf(err)?.reason).toBe("vault_mismatch");
    expect(backend).not.toHaveBeenCalled();
  });
  it("a previous Settler that is not a 0x deployment is dropped; the current one alone stands", async () => {
    vi.stubGlobal("fetch", recordedFetch(f, {registry: {current: f.registry.current, prev: ATTACKER}}));
    expect(await createSettlerResolver({chains: chainsOf(f), rpcUrls: rpcOf(f)}).resolve(8453)).toEqual([f.registry.current]);
  });
  it("every real Settler of the recordings is a registry deployment; an EOA or another contract never is", () => {
    expect(zeroExSettlerAddress(8453, 22)).toBe(f.registry.current);
    for (const a of [ATTACKER, "0x9999999999999999999999999999999999999999", "0x000000000022D473030F116dDEE9F6B43aC78BA3"]) {
      for (const id of [1, 10, 56, 137, 8453, 42161, 43114]) expect(zeroExSettlerNonce(id, a), `${a} on ${id}`).toBeNull();
    }
  });
});

describe("probe 4: a permit valid for longer than 0x ever asks (inside the core reader's hour)", () => {
  it("is refused on the device", async () => {
    const f = loadRecorded("base-usdc-eth");
    vi.setSystemTime(f.request.nowMs);
    vi.stubGlobal("fetch", recordedFetch(f));
    const honest = await zeroExProvider({apiKey: getKey, rpcUrls: rpcOf(f), chains: chainsConfigOf(f)}).getQuote(paramsOf(f));
    const permit = JSON.parse(honest!.txRequest!.permit2Transfer!);
    permit.message.deadline = String(Math.floor(f.request.nowMs / 1000) + 3000);
    expect(zeroExVerifyQuote(paramsOf(f), {...honest!, txRequest: {...honest!.txRequest!, permit2Transfer: JSON.stringify(permit)}}, ctxOf(f))).toBe("the Permit2 deadline is more than 600 s away");
  });
});

describe("probe 5: the API key and redirects", () => {
  it("the API request refuses to follow a redirect (the key header would travel with it)", async () => {
    const f = loadRecorded("base-usdc-eth-price");
    vi.setSystemTime(f.request.nowMs);
    const inits: RequestInit[] = [];
    const inner = recordedFetch(f);
    vi.stubGlobal("fetch", vi.fn(async (u: string, init: RequestInit) => { inits.push(init); return (inner as (u: string, i: RequestInit) => Promise<Response>)(u, init); }));
    expect(await zeroExProvider({apiKey: getKey, chains: chainsConfigOf(f)}).getQuote(paramsOf(f))).not.toBeNull();
    expect(inits[0]!.redirect).toBe("error");
  });
});

describe("probe 6: activity history", () => {
  it("a contract that copies the execute selector is not labelled a 0x swap; the real Settler call is", () => {
    const f = loadRecorded("base-usdc-eth");
    const tx = (to: string): ChainTx => ({
      chain: `eip155:${chainIdOf(f)}`, hash: `0x${"1".repeat(64)}`, time: 1, status: "confirmed", address: f.request.refundAddress, from: f.request.refundAddress, to, nativeValue: 0n,
      transfers: [{token: USDC.toLowerCase(), from: f.request.refundAddress.toLowerCase(), to: to.toLowerCase(), amount: 25_000_000n, standard: "erc20"}, {token: null, from: to.toLowerCase(), to: f.request.refundAddress.toLowerCase(), amount: 10n ** 16n, standard: "native"}] as never,
      call: {to, selector: "0x1fff991f", data: f.response.transaction.data},
    });
    const ctx = {own: new Set([f.request.refundAddress.toLowerCase()])};
    expect(describeZeroExActivity(tx(ATTACKER), ctx)).toBeNull();
    expect(describeZeroExActivity(tx(f.response.transaction.to), ctx)).not.toBeNull();
  });
});

/**
 * Monad (eip155:143) in the default chain table (0.2.0). Read on chain 2026-11-25 (UNISWAP-V4-RESEARCH §7.4, every
 * reading re-derived): the registry is the same ERC-1967 proxy as on the other chains, ownerOf(2) is deployment 12
 * (0x's 2026-11-24 release, code from block 125,122,253), prev(2) is 11, deployments 1–12 hold code and 13+ none,
 * Permit2 is canonical and the wrapped native is WMON. The checks below are the ones every chain gets, on Monad's
 * own pins: a native-coin sale only to 12 or 11, a token sale up to 14 once it holds code, nothing older than 11.
 */
import {afterEach, describe, expect, it, vi} from "vitest";
import type {ChainTx} from "@anywalletkit/core";
import {refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {ZEROEX_CHAINS, ZEROEX_PERMIT2, ZEROEX_SETTLER_NONCE_MARGIN, ZEROEX_SETTLER_REGISTRY, zeroExChain, zeroExChains} from "../src/chains.js";
import {ZEROEX_MODULE, describeZeroExActivity} from "../src/activity.js";
import {zeroExProvider} from "../src/provider.js";
import {zeroExRemoteProvider} from "../src/remote.js";
import {checkZeroExTransaction, createSettlerResolver, zeroExSettlerAddress, zeroExSettlerNonce} from "../src/settler.js";
import {ME, ZERO, executeData, getKey, nativeCheckAction, stub} from "./fixtures.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const MONAD = 143;
const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const RPC = {[MONAD]: ["https://rpc.test"]};
const at = (nonce: number) => zeroExSettlerAddress(MONAD, nonce);
/** Monad on 2026-11-25: deployments 1–12 hold code, nothing past them. */
const deployedUpTo = (n: number) => (address: string) => Array.from({length: n}, (_, i) => at(i + 1).toLowerCase()).includes(address.toLowerCase());
const caught = async (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);
const MON_IN = 100n * 10n ** 18n;
const MIN = 99_500_000n;

describe("the Monad row", () => {
  it("is in the default table: the one registry, WMON, pinned 12 / 11, token sales up to 14, a gas cap of 15,000,000", () => {
    const monad = zeroExChain(ZEROEX_CHAINS, MONAD)!;
    expect(monad).toEqual({name: "Monad", registry: ZEROEX_SETTLER_REGISTRY, newestLiveNonce: 12, previousLiveNonce: 11, wrappedNative: WMON, maxGasLimit: 15_000_000n});
    expect(monad.newestLiveNonce + ZEROEX_SETTLER_NONCE_MARGIN).toBe(14);
    expect(Object.isFrozen(monad)).toBe(true);
  });
  it("pins the Settlers the registry named on 2026-11-25 (CREATE3 of the registry, computed offline)", () => {
    expect(at(12)).toBe("0xF16D1df42E368e4dd873b1f92ED0670FF4c987eB");
    expect(at(11)).toBe("0x031D28683fFc9936903a31670bC618b8Bc9b65dD");
    expect(zeroExSettlerNonce(MONAD, "0xf16d1df42e368e4dd873b1f92ed0670ff4c987eb")).toBe(12);
    expect(zeroExSettlerNonce(MONAD, "0x031D28683fFc9936903a31670bC618b8Bc9b65dD")).toBe(11);
    // chain-bound: Monad's Settler is no Settler on Base, Base's none on Monad
    expect(zeroExSettlerNonce(8453, at(12))).toBeNull();
    expect(zeroExSettlerNonce(MONAD, zeroExSettlerAddress(8453, 23))).toBeNull();
  });
  it("is served by both providers, and a chain table without it serves no Monad", () => {
    expect(zeroExProvider({apiKey: getKey, rpcUrls: RPC}).supportsChain!("eip155:143")).toBe(true);
    expect(zeroExRemoteProvider({baseUrl: "https://backend.example/api", rpcUrls: RPC}).supportsChain!("eip155:143")).toBe(true);
    expect(zeroExProvider({apiKey: getKey, rpcUrls: RPC, chains: {[MONAD]: null}}).supportsChain!("eip155:143")).toBe(false);
  });
});

describe("the resolver on Monad", () => {
  const resolver = (registry: {current?: string | null; prev?: string | null}, deployed = deployedUpTo(12)) => {
    vi.stubGlobal("fetch", stub({registry, code: deployed}));
    return createSettlerResolver({chains: ZEROEX_CHAINS, rpcUrls: RPC});
  };

  it("accepts the pinned pair, current first: [12, 11]", async () => {
    expect(await resolver({current: at(12), prev: at(11)}).resolve(MONAD)).toEqual([at(12), at(11)]);
  });
  it("accepts 0x's next deployment (13) once it holds code, for token sales: [13, 12]", async () => {
    expect(await resolver({current: at(13), prev: at(12)}, deployedUpTo(13)).resolve(MONAD)).toEqual([at(13), at(12)]);
  });
  it("refuses 13 while it holds no contract", async () => {
    const err = await caught(resolver({current: at(13), prev: at(12)}).resolve(MONAD));
    expect((err as Error).message).toBe(`zeroex: the RPC on chain 143 names ${at(13)} (Settler deployment 13) as the 0x Settler, but no contract is deployed there`);
    expect(refusalOf(err)?.reason).toBe("vault_mismatch");
  });
  it("refuses 15, past the margin, with what to do", async () => {
    const err = await caught(resolver({current: at(15), prev: at(14)}, deployedUpTo(15)).resolve(MONAD));
    expect((err as Error).message).toBe(`zeroex: the 0x registry on chain 143 names Settler deployment 15 (${at(15)}), newer than the newest this module accepts there (14) — update @anywalletkit/protocol-swap2-0x, or raise the chain's newestLiveNonce and previousLiveNonce once that deployment is checked`);
    expect(refusalOf(err)?.reason).toBe("vault_mismatch");
  });
  it("refuses 10, a replaced Settler older than the pinned previous, and drops it as the previous one", async () => {
    const err = await caught(resolver({current: at(10), prev: at(9)}).resolve(MONAD));
    expect((err as Error).message).toBe(`zeroex: the RPC on chain 143 names ${at(10)} (Settler deployment 10) as the 0x Settler, older than the oldest this module accepts there (11) — a replaced Settler is not called`);
    expect(refusalOf(err)?.reason).toBe("vault_mismatch");
    expect(await resolver({current: at(12), prev: at(10)}).resolve(MONAD)).toEqual([at(12)]);
  });
});

describe("a native MON sale goes only to Monad's pinned Settlers", () => {
  const nativeTx = (to: string) => {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60);
    return {to, data: executeData({recipient: ME, buyToken: AUSD, min: MIN, first: nativeCheckAction(deadline, MON_IN)}), value: MON_IN.toString(), chainId: MONAD};
  };
  const expectation = (settlers: readonly string[]) => ({chainId: MONAD, settlers, sellToken: ZERO, buyToken: AUSD, sellAmount: MON_IN, recipient: ME, minBuyAmount: MIN});

  it("12 and 11 pass", () => {
    for (const n of [12, 11]) expect(() => checkZeroExTransaction(nativeTx(at(n)), expectation([at(12), at(11), at(13)]))).not.toThrow();
  });
  it("13 (inside the token margin) is refused for value, whatever the registry and the RPC claim", () => {
    let err: unknown;
    try { checkZeroExTransaction(nativeTx(at(13)), expectation([at(13), at(12)])); } catch (e) { err = e; }
    expect((err as Error).message).toBe(`zeroex: the swap sends native coin to Settler deployment 13 (${at(13)}) on chain 143, newer than the newest one live when this module's chain table was pinned (12) — a native-coin sale goes only to a pinned Settler: update @anywalletkit/protocol-swap2-0x`);
    expect(refusalOf(err)?.reason).toBe("vault_mismatch");
  });
  it("15 (past the margin) and 10 (older than the previous) are no Settler this module accepts on Monad", () => {
    for (const n of [15, 10]) {
      let err: unknown;
      try { checkZeroExTransaction(nativeTx(at(n)), expectation([at(n)])); } catch (e) { err = e; }
      expect((err as Error).message, String(n)).toBe(`zeroex: the transaction target ${at(n)} is not a 0x Settler deployment this module accepts on chain 143`);
      expect(refusalOf(err)?.reason).toBe("vault_mismatch");
    }
  });
});

describe("quotes on Monad through the provider", () => {
  const params = (over: Partial<QuoteParams> = {}): QuoteParams => ({sourceChain: "eip155:143", destChain: "eip155:143", sourceToken: ZERO, destToken: AUSD, amountIn: MON_IN.toString(), slippageBps: 50, destAddress: ME, refundAddress: ME, dry: false, ...over});
  const quote = async (settler: string, over: Partial<QuoteParams> = {}, deployed = deployedUpTo(12)) => {
    vi.stubGlobal("fetch", stub({settler, registry: {current: settler, prev: at(11)}, code: deployed, out: 100_000_000n}));
    const heard: [string, string | undefined][] = [];
    const q = await zeroExProvider({apiKey: getKey, rpcUrls: RPC}).getQuote(params({onRefusal: (t, info) => heard.push([t, info?.reason]), ...over}));
    return {q, heard};
  };

  it("MON → AUSD to Settler 12: a native sale with no allowance and no permit", async () => {
    const {q, heard} = await quote(at(12));
    expect(heard).toEqual([]);
    expect(q!.txRequest!.to!.toLowerCase()).toBe(at(12).toLowerCase());
    expect(q!.txRequest!.value).toBe(MON_IN.toString());
    expect(q!.txRequest!.approvalAddress).toBeUndefined();
  });
  it("MON → AUSD to Settler 13 (0x moved on, the pin not yet raised) is refused, classified", async () => {
    const {q, heard} = await quote(at(13), {}, deployedUpTo(13));
    expect(q).toBeNull();
    expect(heard).toHaveLength(1);
    expect(heard[0]![0]).toContain("native coin to Settler deployment 13");
    expect(heard[0]![1]).toBe("vault_mismatch");
  });
  it("USDC → MON to Settler 13 (inside the margin, with code): a Permit2 token sale, Permit2 as the only allowance target", async () => {
    const {q, heard} = await quote(at(13), {sourceToken: USDC, sourceDecimals: 6, destToken: ZERO, amountIn: "25000000"}, deployedUpTo(13));
    expect(heard).toEqual([]);
    expect(q!.txRequest!.to!.toLowerCase()).toBe(at(13).toLowerCase());
    expect(q!.txRequest!.value).toBe("0");
    expect(q!.txRequest!.approvalAddress).toBe(ZEROEX_PERMIT2);
  });
  it("Monad's 15,000,000 gas cap is on the padded limit (gas × 1.2 + 20,000): 0x asking for 12,483,334 passes, 12,483,335 is refused", async () => {
    // Every other chain keeps 6,000,000 (0x asking for at most 4,983,334); on Monad a quote past that passes up to 15,000,000.
    const withGas = (gas: string) => (body: Record<string, any>) => ({...body, transaction: {...body.transaction, gas}});
    const run = async (gas: string) => {
      vi.stubGlobal("fetch", stub({settler: at(12), registry: {current: at(12), prev: at(11)}, code: deployedUpTo(12), out: 100_000_000n, tamper: withGas(gas)}));
      const heard: [string, string | undefined][] = [];
      const q = await zeroExProvider({apiKey: getKey, rpcUrls: RPC}).getQuote(params({onRefusal: (t, info) => heard.push([t, info?.reason])}));
      return {q, heard};
    };
    for (const [gas, limit] of [["4983335", "6000002"], ["5025000", "6050000"], ["12475000", "14990000"], ["12483334", "15000000"]] as const) {
      const ok = await run(gas);
      expect(ok.heard, gas).toEqual([]);
      expect(ok.q!.txRequest!.gasLimit, gas).toBe(limit);
    }
    const over = await run("12483335");
    expect(over.q).toBeNull();
    expect(over.heard).toEqual([["zeroex: the transaction asks for more gas than any 0x swap needs (its gas limit must be 1 to 15000000 on chain 143)", "policy_refused"]]);
  });
  it("MON ↔ WMON is a wrap, not a 0x swap: refused up front", async () => {
    const {q, heard} = await quote(at(12), {destToken: WMON});
    expect(q).toBeNull();
    expect(heard.map(([, reason]) => reason)).toEqual(["unsupported_pair"]);
  });
});

describe("activity: a Monad Settler execute is labelled a 0x swap", () => {
  const tx = (to: string, chain = "eip155:143"): ChainTx => {
    const deadline = 1_795_000_000n;
    const data = executeData({recipient: ME, buyToken: AUSD, min: MIN, first: nativeCheckAction(deadline, MON_IN)});
    return {
      chain, hash: `0x${"ab".repeat(32)}`, time: 1_795_000_000, status: "confirmed", address: ME.toLowerCase(), from: ME.toLowerCase(), to: to.toLowerCase(), nativeValue: MON_IN,
      transfers: [
        {token: null, from: ME.toLowerCase(), to: to.toLowerCase(), amount: MON_IN, standard: "native"},
        {token: AUSD.toLowerCase(), from: to.toLowerCase(), to: ME.toLowerCase(), amount: 99_800_000n, standard: "erc20"},
      ],
      call: {to: to.toLowerCase(), selector: "0x1fff991f", data},
    } as unknown as ChainTx;
  };
  const own = new Set([ME.toLowerCase()]);

  it("deployments 12 and 11 (and the ones before: past swaps went there) are labelled", () => {
    for (const n of [12, 11, 1]) {
      const item = describeZeroExActivity(tx(at(n)), {own});
      expect(item, String(n)).not.toBeNull();
      expect(item!.kind).toBe("swap");
      expect(item!.protocol).toBe(ZEROEX_MODULE);
      expect(item!.subtitle).toMatch(/^0x · /);
    }
  });
  it("an address that is no Monad Settler is not", () => {
    expect(describeZeroExActivity(tx("0x9999999999999999999999999999999999999999"), {own})).toBeNull();
    expect(describeZeroExActivity(tx(zeroExSettlerAddress(8453, 23)), {own})).toBeNull();
  });
  it("both providers label with the table they were built with: a chain removed through `chains` is not labelled", () => {
    const removed = {[MONAD]: null};
    expect(zeroExProvider({apiKey: getKey, rpcUrls: RPC}).describeActivity!(tx(at(12)), {own})).not.toBeNull();
    expect(zeroExProvider({apiKey: getKey, rpcUrls: RPC, chains: removed}).describeActivity!(tx(at(12)), {own})).toBeNull();
    expect(zeroExRemoteProvider({baseUrl: "https://backend.example/api", rpcUrls: RPC, chains: removed}).describeActivity!(tx(at(12)), {own})).toBeNull();
  });
  it("a chain added through `chains` is labelled too (it was read from the default table only before 0.2.0)", () => {
    // Unichain as an integrator would add it: same registry, its own pins (UNISWAP-V4-RESEARCH §7.4: 13 / 12).
    const unichain = {130: {name: "Unichain", registry: ZEROEX_SETTLER_REGISTRY, newestLiveNonce: 13, previousLiveNonce: 12, wrappedNative: "0x4200000000000000000000000000000000000006"}};
    const onUnichain = tx(zeroExSettlerAddress(130, 13), "eip155:130");
    expect(describeZeroExActivity(onUnichain, {own})).toBeNull();
    expect(describeZeroExActivity(onUnichain, {own}, zeroExChains(unichain))).not.toBeNull();
    expect(zeroExProvider({apiKey: getKey, rpcUrls: RPC, chains: unichain}).describeActivity!(onUnichain, {own})).not.toBeNull();
    expect(zeroExRemoteProvider({baseUrl: "https://backend.example/api", rpcUrls: RPC, chains: unichain}).describeActivity!(onUnichain, {own})).not.toBeNull();
    // and its pins bound it like any chain's: a deployment past them is not labelled
    expect(describeZeroExActivity(tx(zeroExSettlerAddress(130, 16), "eip155:130"), {own}, zeroExChains(unichain))).toBeNull();
  });
});

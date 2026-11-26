/**
 * The gas cap per chain (owner decision 2026-11-26). Monad bills the gas limit and its Settler swaps take 7–10 times
 * the gas of the same swap on Base, so under one 6,000,000 cap for every chain 0x sales of MON from about $10,000 were
 * refused. Monad's table entry now carries its own cap, 15,000,000 (`maxGasLimit`); every other chain keeps
 * `ZEROEX_MAX_GAS_LIMIT`, 6,000,000. The cap is on the padded limit (0x's `transaction.gas` × 1.2 + 20,000) and holds
 * wherever a quoted gas limit is checked: the provider, the remote verifiers, `checkZeroExTransaction` and the
 * preflight. A chain table entry may set a cap of its own only as a bigint from 1 to 30,000,000 (Monad's
 * per-transaction gas limit): config can raise a chain's cap, never remove the bound.
 */
import {afterEach, describe, expect, it, vi} from "vitest";
import {refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {ZEROEX_CHAINS, ZEROEX_GAS_CAP_CEILING, ZEROEX_SETTLER_REGISTRY, isZeroExGasCap, zeroExChains, type ZeroExChain} from "../src/chains.js";
import {zeroExPreflightDeposit, zeroExProvider} from "../src/provider.js";
import {zeroExPins, zeroExVerifyBuild, zeroExVerifyQuote} from "../src/remote.js";
import {ZEROEX_MAX_GAS_LIMIT, checkZeroExGasLimit, checkZeroExTransaction, createSettlerResolver, zeroExMaxGasLimit, zeroExSettlerAddress} from "../src/settler.js";
import {ME, ZERO, executeData, getKey, nativeCheckAction, stub} from "./fixtures.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const MONAD = 143;
const AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";
const TOKEN = "0x1111111111111111111111111111111111111111";
const IN = 10n ** 18n;
const MIN = 1_000_000n;
const ids = Object.keys(ZEROEX_CHAINS).map(Number);
const others = ids.filter((id) => id !== MONAD);
const caught = (fn: () => unknown): unknown => { try { fn(); return null; } catch (e) { return e; } };
const text = (id: number, cap: bigint) => `zeroex: the transaction asks for more gas than any 0x swap needs (its gas limit must be 1 to ${cap} on chain ${id})`;

/** A native-coin sale on `id` to its pinned newest Settler, as 0x builds it (checkZeroExTransaction directly). */
function nativeSale(id: number, gasLimit?: string) {
  const to = zeroExSettlerAddress(id, ZEROEX_CHAINS[id]!.newestLiveNonce);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60);
  const tx = {to, data: executeData({recipient: ME, buyToken: TOKEN, min: MIN, first: nativeCheckAction(deadline, IN)}), value: IN.toString(), chainId: id, ...(gasLimit !== undefined ? {gasLimit} : {})};
  const expectation = {chainId: id, settlers: [to], sellToken: ZERO, buyToken: TOKEN, sellAmount: IN, recipient: ME, minBuyAmount: MIN};
  return {tx, expectation};
}

describe("the table's caps", () => {
  it("Monad alone carries its own cap, 15,000,000; every other chain keeps the default 6,000,000; no entry may set more than 30,000,000", () => {
    expect(ZEROEX_MAX_GAS_LIMIT).toBe(6_000_000n);
    expect(ZEROEX_GAS_CAP_CEILING).toBe(30_000_000n);
    expect(Object.fromEntries(Object.entries(ZEROEX_CHAINS).map(([id, c]) => [id, c.maxGasLimit]))).toEqual({
      1: undefined, 10: undefined, 56: undefined, 137: undefined, 143: 15_000_000n, 8453: undefined, 42161: undefined, 43114: undefined,
    });
    expect(Object.fromEntries(Object.entries(ZEROEX_CHAINS).map(([id, c]) => [id, zeroExMaxGasLimit(c)]))).toEqual({
      1: 6_000_000n, 10: 6_000_000n, 56: 6_000_000n, 137: 6_000_000n, 143: 15_000_000n, 8453: 6_000_000n, 42161: 6_000_000n, 43114: 6_000_000n,
    });
    for (const id of others) expect(ZEROEX_CHAINS[id], String(id)).not.toHaveProperty("maxGasLimit");
    // the defaults pass the same validation a caller's table does, cap included
    expect(zeroExChains(ZEROEX_CHAINS)).toEqual(ZEROEX_CHAINS);
    expect(zeroExChains(ZEROEX_CHAINS)[MONAD]!.maxGasLimit).toBe(15_000_000n);
  });
});

describe("checkZeroExTransaction holds the gas limit to the chain's cap, exactly", () => {
  it.each(others)("chain %i: 6,000,000 passes, 6,000,001 is refused (policy_refused, naming the chain's cap)", (id) => {
    const at = nativeSale(id, "6000000");
    expect(() => checkZeroExTransaction(at.tx, at.expectation)).not.toThrow();
    const over = nativeSale(id, "6000001");
    const err = caught(() => checkZeroExTransaction(over.tx, over.expectation));
    expect((err as Error).message).toBe(text(id, 6_000_000n));
    expect(refusalOf(err)?.reason).toBe("policy_refused");
    // the cap Monad has is no other chain's
    expect((caught(() => checkZeroExTransaction(nativeSale(id, "15000000").tx, over.expectation)) as Error).message).toBe(text(id, 6_000_000n));
  });

  it("Monad: a padded 6,050,000 and 14,990,000 pass, exactly 15,000,000 passes, 15,000,001 is refused", () => {
    for (const gas of ["6000001", "6050000", "14990000", "15000000"]) {
      const s = nativeSale(MONAD, gas);
      expect(() => checkZeroExTransaction(s.tx, s.expectation), gas).not.toThrow();
    }
    const over = nativeSale(MONAD, "15000001");
    const err = caught(() => checkZeroExTransaction(over.tx, over.expectation));
    expect((err as Error).message).toBe(text(MONAD, 15_000_000n));
    expect(refusalOf(err)?.reason).toBe("policy_refused");
  });

  it("a zero, non-decimal or over-long gas limit is refused on every chain; none at all passes", () => {
    for (const id of ids) {
      for (const gas of ["0", "0x10", "1e6", "-1", "1000000000000"]) {
        expect((caught(() => checkZeroExTransaction(nativeSale(id, gas).tx, nativeSale(id).expectation)) as Error).message, `${id} ${gas}`).toBe(text(id, zeroExMaxGasLimit(ZEROEX_CHAINS[id]!)));
      }
      expect(() => checkZeroExTransaction(nativeSale(id).tx, nativeSale(id).expectation)).not.toThrow();
    }
  });

  it("the cap is the chain entry's: a Monad entry without one (an integrator's own) has the default 6,000,000", () => {
    const {maxGasLimit: _drop, ...plain} = ZEROEX_CHAINS[MONAD]!;
    const chain = zeroExChains({[MONAD]: plain})[MONAD]!;
    expect(chain.maxGasLimit).toBeUndefined();
    const s = nativeSale(MONAD, "6000001");
    expect((caught(() => checkZeroExTransaction(s.tx, {...s.expectation, chain})) as Error).message).toBe(text(MONAD, 6_000_000n));
    // …and a chain given its own cap through config uses it, up to 30,000,000
    const base = zeroExChains({8453: {...ZEROEX_CHAINS[8453]!, maxGasLimit: 30_000_000n}})[8453]!;
    const b = nativeSale(8453, "30000000");
    expect(() => checkZeroExTransaction(b.tx, {...b.expectation, chain: base})).not.toThrow();
    expect((caught(() => checkZeroExTransaction(nativeSale(8453, "30000001").tx, {...b.expectation, chain: base})) as Error).message).toBe(text(8453, 30_000_000n));
  });

  it("an entry built by hand, past zeroExChains, cannot lift the bound: an out-of-range cap throws at the check", () => {
    for (const maxGasLimit of [0n, -1n, 30_000_001n, 10n ** 30n, 15_000_000, "15000000", null]) {
      const chain = {...ZEROEX_CHAINS[MONAD]!, maxGasLimit} as unknown as ZeroExChain;
      const s = nativeSale(MONAD, "6000000");
      const err = caught(() => checkZeroExTransaction(s.tx, {...s.expectation, chain}));
      expect((err as Error).message, String(maxGasLimit)).toBe("zeroex: the chain table's gas cap for chain 143 is not a bigint from 1 to 30000000");
      // and with no gas limit on the transaction too: a broken table refuses, it does not skip the check
      expect(caught(() => checkZeroExTransaction(nativeSale(MONAD).tx, {...s.expectation, chain})), String(maxGasLimit)).toBeInstanceOf(Error);
      expect(() => checkZeroExGasLimit(undefined, chain, MONAD)).toThrow(/gas cap for chain 143 is not a bigint/);
    }
  });
});

describe("a chain table entry's cap is validated", () => {
  const entry = (over: Record<string, unknown>): ZeroExChain => ({name: "Unichain", registry: ZEROEX_SETTLER_REGISTRY, newestLiveNonce: 4, previousLiveNonce: 3, ...over}) as ZeroExChain;
  const why = /chain 130 gas cap \(maxGasLimit\) is not a bigint from 1 to 30000000/;

  it("0, a negative, more than 30,000,000, a number, a string or null throws", () => {
    for (const maxGasLimit of [0n, -1n, -15_000_000n, 30_000_001n, 2n ** 64n, 15_000_000, 15e6, "15000000", null, {}]) {
      expect(() => zeroExChains({130: entry({maxGasLimit})}), String(maxGasLimit)).toThrow(why);
    }
    // …on Monad's own row too: an override cannot remove the bound
    expect(() => zeroExChains({[MONAD]: {...ZEROEX_CHAINS[MONAD]!, maxGasLimit: 30_000_001n}})).toThrow(/chain 143 gas cap \(maxGasLimit\) is not a bigint from 1 to 30000000/);
  });

  it("1 and 30,000,000 are accepted; absent is the default cap; isZeroExGasCap is the same rule", () => {
    expect(zeroExChains({130: entry({maxGasLimit: 1n})})[130]!.maxGasLimit).toBe(1n);
    expect(zeroExChains({130: entry({maxGasLimit: 30_000_000n})})[130]!.maxGasLimit).toBe(30_000_000n);
    expect(zeroExChains({130: entry({})})[130]).not.toHaveProperty("maxGasLimit");
    expect(zeroExMaxGasLimit(zeroExChains({130: entry({})})[130]!)).toBe(ZEROEX_MAX_GAS_LIMIT);
    expect([1n, 15_000_000n, 30_000_000n].every(isZeroExGasCap)).toBe(true);
    expect([0n, -1n, 30_000_001n, 15_000_000, "1", null, undefined].some(isZeroExGasCap)).toBe(false);
  });
});

// ── the cap through the provider, the remote verifiers and the preflight ───

const at = (nonce: number) => zeroExSettlerAddress(MONAD, nonce);
const deployed = (address: string) => Array.from({length: 12}, (_, i) => at(i + 1).toLowerCase()).includes(address.toLowerCase());
const RPC = {[MONAD]: ["https://rpc.test"], 8453: ["https://rpc.test"]};
const monadParams = (over: Partial<QuoteParams> = {}): QuoteParams => ({sourceChain: "eip155:143", destChain: "eip155:143", sourceToken: ZERO, destToken: AUSD, amountIn: (100n * IN).toString(), slippageBps: 50, destAddress: ME, refundAddress: ME, dry: false, ...over});
const withGas = (gas: string) => (body: Record<string, any>) => ({...body, transaction: {...body.transaction, gas}});

async function monadQuote(gas: string, chains?: Parameters<typeof zeroExProvider>[0]["chains"]) {
  vi.stubGlobal("fetch", stub({settler: at(12), registry: {current: at(12), prev: at(11)}, code: deployed, out: 100_000_000n, tamper: withGas(gas)}));
  const heard: [string, string | undefined][] = [];
  const provider = zeroExProvider({apiKey: getKey, rpcUrls: RPC, ...(chains ? {chains} : {})});
  const q = await provider.getQuote(monadParams({onRefusal: (t, info) => heard.push([t, info?.reason])}));
  return {provider, q, heard};
}

describe("the provider pads 0x's gas and holds it to the chain's cap", () => {
  it("Monad: 0x asking for 5,025,000 (padded 6,050,000) and 12,475,000 (padded 14,990,000) passes; 12,483,335 (padded 15,000,002) is refused", async () => {
    for (const [gas, limit] of [["5025000", "6050000"], ["12475000", "14990000"]] as const) {
      const {q, heard} = await monadQuote(gas);
      expect(heard, gas).toEqual([]);
      expect(q!.txRequest!.gasLimit).toBe(limit);
    }
    const over = await monadQuote("12483335");
    expect(over.q).toBeNull();
    expect(over.heard).toEqual([[text(MONAD, 15_000_000n), "policy_refused"]]);
  });

  it("Monad with an entry of the integrator's own that sets no cap: 6,000,000 again (0x asking for 5,025,000 is refused)", async () => {
    const {maxGasLimit: _drop, ...plain} = ZEROEX_CHAINS[MONAD]!;
    const {q, heard} = await monadQuote("5025000", {[MONAD]: plain});
    expect(q).toBeNull();
    expect(heard).toEqual([[text(MONAD, 6_000_000n), "policy_refused"]]);
  });

  it("Base: 0x asking for 4,983,334 (padded 6,000,000) passes, 4,983,335 (padded 6,000,002) is refused — Monad's cap is not Base's", async () => {
    const run = async (gas: string) => {
      vi.stubGlobal("fetch", stub({out: 2_500_000n, tamper: withGas(gas)}));
      const heard: [string, string | undefined][] = [];
      const q = await zeroExProvider({apiKey: getKey, rpcUrls: RPC}).getQuote({sourceChain: "eip155:8453", destChain: "eip155:8453", sourceToken: ZERO, destToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amountIn: (10n ** 15n).toString(), slippageBps: 50, destAddress: ME, refundAddress: ME, dry: false, onRefusal: (t, info) => heard.push([t, info?.reason])});
      return {q, heard};
    };
    const top = await run("4983334");
    expect(top.heard).toEqual([]);
    expect(top.q!.txRequest!.gasLimit).toBe("6000000");
    const over = await run("4983335");
    expect(over.q).toBeNull();
    expect(over.heard).toEqual([[text(8453, 6_000_000n), "policy_refused"]]);
  });
});

describe("the remote verifiers and the preflight hold the same cap", () => {
  const settlers = () => [at(12), at(11)];

  it("zeroExVerifyQuote / zeroExPins: Monad's padded 14,990,000 passes against the default table, refused against one without Monad's cap", async () => {
    const {q} = await monadQuote("12475000");
    const params = monadParams();
    expect(zeroExVerifyQuote(params, q!, {chains: ZEROEX_CHAINS, settlers})).toBeNull();
    const {maxGasLimit: _drop, ...plain} = ZEROEX_CHAINS[MONAD]!;
    const refused = zeroExVerifyQuote(params, q!, {chains: zeroExChains({[MONAD]: plain}), settlers});
    expect(refused).toBe("the transaction asks for more gas than any 0x swap needs (its gas limit must be 1 to 6000000 on chain 143)");
    expect(zeroExPins().reasonOf!(refused!)?.reason).toBe("policy_refused");
    // a backend that raises the limit past the cap after quoting
    const raised: Quote = {...q!, txRequest: {...q!.txRequest!, gasLimit: "15000001"}};
    expect(zeroExVerifyQuote(params, raised, {chains: ZEROEX_CHAINS, settlers})).toBe("the transaction asks for more gas than any 0x swap needs (its gas limit must be 1 to 15000000 on chain 143)");
  });

  it("zeroExVerifyBuild: the build of that quote passes on Monad, and fails for a table without Monad's cap", async () => {
    const {provider, q} = await monadQuote("12475000");
    const tx = await provider.buildDeposit(q!);
    const resolver = createSettlerResolver({chains: ZEROEX_CHAINS, rpcUrls: RPC});
    expect(await zeroExVerifyBuild(q!, tx, monadParams(), {chains: ZEROEX_CHAINS, settlers, resolver})).toBeNull();
    const {maxGasLimit: _drop, ...plain} = ZEROEX_CHAINS[MONAD]!;
    const chains = zeroExChains({[MONAD]: plain});
    expect(await zeroExVerifyBuild(q!, tx, monadParams(), {chains, settlers, resolver: createSettlerResolver({chains, rpcUrls: RPC})})).toMatch(/must be 1 to 6000000 on chain 143/);
  });

  it("zeroExPreflightDeposit: a built transaction over the chain's cap is refused before the registry is read; within it, it passes", async () => {
    const {provider, q} = await monadQuote("12475000");
    const tx = await provider.buildDeposit(q!);
    const calls: {url: string; method: string}[] = [];
    vi.stubGlobal("fetch", stub({registry: {current: at(12), prev: at(11)}, code: deployed, calls: calls as never}));
    const resolver = createSettlerResolver({chains: ZEROEX_CHAINS, rpcUrls: RPC});
    await expect(zeroExPreflightDeposit(q!, tx, {chains: ZEROEX_CHAINS, resolver})).resolves.toBeUndefined();
    const reads = calls.length;
    const over = {...tx, gasLimit: "15000001"};
    const quoted = {...q!, txRequest: {...q!.txRequest!, gasLimit: "15000001"}};
    const err = await zeroExPreflightDeposit(quoted, over, {chains: ZEROEX_CHAINS, resolver: createSettlerResolver({chains: ZEROEX_CHAINS, rpcUrls: RPC})}).then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe(text(MONAD, 15_000_000n));
    expect(refusalOf(err)?.reason).toBe("policy_refused");
    expect(calls.length).toBe(reads);
    // the same transaction on a table without Monad's cap: refused at 6,000,000
    const {maxGasLimit: _drop, ...plain} = ZEROEX_CHAINS[MONAD]!;
    const chains = zeroExChains({[MONAD]: plain});
    await expect(zeroExPreflightDeposit(q!, tx, {chains, resolver: createSettlerResolver({chains, rpcUrls: RPC})})).rejects.toThrow(text(MONAD, 6_000_000n));
  });
});

// Quote.gasEstimate (2026-11-28): a wrap / unwrap quote carries the gas its call uses on that chain's pinned wrapper,
// from the module's measured table (WRAP_GAS, source "model"). fixtures/gas/measured-2026-11-28.json holds the
// measurements behind it: per chain, eth_simulateV1 of the module's own calls (deposit() into an empty balance, into a
// held one, withdraw of part, of the rest) and receipts of public deposit() / withdraw() transactions on the same chain.
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {encodeAbiParameters} from "viem";
import {gasEstimateProblem} from "@anywalletkit/protocol-swap2-core/validate";
import {ccAssetByToken} from "@anywalletkit/swap2-assets";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {WRAP_GAS, WRAP_GAS_LIMIT, WRAPPED_NATIVE, wrapGasLimit, wrapPins, wrapProvider, wrapVerifyQuote} from "../src/provider.js";

afterEach(() => vi.unstubAllGlobals());

type Receipt = {hash: string; block: number; gasUsed: number};
type Measured = {symbol: string; simulation: {block: number; depositIntoEmpty: number; depositIntoHeld: number; withdrawPart: number; withdrawAll: number} | {unavailable: string}; receipts: {deposit: Receipt[]; withdraw: Receipt[]}};
const measured = JSON.parse(readFileSync(new URL("../fixtures/gas/measured-2026-11-28.json", import.meta.url), "utf8")) as {chains: Record<string, Measured>};
const ME = "0x4444444444444444444444444444444444444444";
const ZERO = "0x0000000000000000000000000000000000000000";
const GAS_LIMIT = 90_000n;
const limits = JSON.parse(readFileSync(new URL("../fixtures/gas/limits-2026-11-28.json", import.meta.url), "utf8")) as {chains: Record<string, {deposit: number; withdraw?: number[]}>};

/** Each chain's wrapper answers its own symbol and 18 decimals; the chain is read from the RPC URL. */
function stub(): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const chainId = Number(String(url).split("/").pop());
    const req = JSON.parse(String(init?.body)) as {params: [{data: string}]};
    const result = req.params[0].data === "0x95d89b41" ? encodeAbiParameters([{type: "string"}], [WRAPPED_NATIVE[chainId]!.symbol]) : encodeAbiParameters([{type: "uint8"}], [18]);
    return new Response(JSON.stringify({result}));
  }) as typeof fetch;
}
const rpcUrls = Object.fromEntries(Object.keys(WRAPPED_NATIVE).map((id) => [Number(id), [`https://rpc.test/${id}`]]));
/** A wrap (native → wrapped) or an unwrap request on a chain, by the catalog's symbols for the two sides. */
const params = (chainId: number, wrap: boolean): QuoteParams => {
  const chain = `eip155:${chainId}`;
  const w = WRAPPED_NATIVE[chainId]!.address;
  const native = ccAssetByToken(chain, ZERO)!.symbol, wrapped = ccAssetByToken(chain, w)!.symbol;
  return {sourceChain: chain, destChain: chain, sourceToken: wrap ? native : wrapped, destToken: wrap ? w : ZERO, amountIn: "1000000000000000", destAddress: ME, refundAddress: ME};
};
const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

describe("wrap gasEstimate: the measured gas of deposit() / withdraw(amount) on the pinned wrapper", () => {
  it("every table entry is the dearer case of its measurement, and a receipt on the same chain confirms it", () => {
    for (const [id, entry] of Object.entries(WRAP_GAS)) {
      const m = measured.chains[id]!;
      expect(m, id).toBeDefined();
      expect(m.symbol, id).toBe(WRAPPED_NATIVE[Number(id)]!.symbol);
      const all = [...m.receipts.deposit, ...m.receipts.withdraw].map((r) => r.gasUsed);
      if ("block" in m.simulation) {
        const s = m.simulation;
        // The dearer case of each direction: into an empty balance (a fresh storage slot), part of the balance (no refund).
        expect(s.depositIntoEmpty - s.depositIntoHeld, id).toBeGreaterThanOrEqual(17_100);
        expect(s.withdrawPart > s.withdrawAll, id).toBe(true);
        if (entry.wrap !== undefined) expect(entry.wrap, id).toBe(String(s.depositIntoEmpty));
        if (entry.unwrap !== undefined) expect(entry.unwrap, id).toBe(String(s.withdrawPart));
        // At least one public transaction on this chain used what the simulation says that case uses (within 64 gas:
        // calldata bytes of the amount differ).
        const cases = [s.depositIntoEmpty, s.depositIntoHeld, s.withdrawPart, s.withdrawAll];
        expect(all.some((g) => cases.some((c) => near(g, c, 64))), id).toBe(true);
      } else {
        // No eth_simulateV1 on the chain's node: receipts alone, which show both cases of the direction, and the
        // figure is the dearer one.
        if (entry.wrap !== undefined) {
          const d = m.receipts.deposit.map((r) => r.gasUsed);
          expect(Math.max(...d) - Math.min(...d), id).toBeGreaterThanOrEqual(17_000);
          expect(entry.wrap, id).toBe(String(Math.max(...d)));
        }
        if (entry.unwrap !== undefined) {
          const w = m.receipts.withdraw.map((r) => r.gasUsed);
          expect(Math.max(...w) - Math.min(...w), id).toBeGreaterThanOrEqual(4_000);
          expect(entry.unwrap, id).toBe(String(Math.max(...w)));
        }
      }
    }
    expect(Object.keys(WRAP_GAS).length).toBe(17);
  });

  it("a quote on a measured chain carries the figure as 'model', within the gas limit it is sent with", async () => {
    vi.stubGlobal("fetch", stub());
    const provider = wrapProvider({rpcUrls});
    let n = 0;
    for (const [id, entry] of Object.entries(WRAP_GAS)) {
      for (const wrap of [true, false]) {
        const figure = wrap ? entry.wrap : entry.unwrap;
        const p = params(Number(id), wrap);
        const q = await provider.getQuote(p);
        expect(q, `${id} ${wrap}`).not.toBeNull();
        expect(q!.gasEstimate, `${id} ${wrap}`).toBe(figure);
        expect(q!.gasEstimateSource, `${id} ${wrap}`).toBe(figure === undefined ? undefined : "model");
        expect(gasEstimateProblem(q!, p.sourceChain), `${id} ${wrap}`).toBeNull();
        expect(q!.txRequest!.gasLimit).toBe(wrapGasLimit(Number(id)));
        if (figure !== undefined) { n++; expect(BigInt(figure) <= BigInt(q!.txRequest!.gasLimit!), `${id} ${wrap}`).toBe(true); }
        expect(wrapVerifyQuote(p, q!), `${id} ${wrap}`).toBeNull();
      }
    }
    expect(n).toBe(32); // 15 chains both ways, Sei and Scroll unwrap only
  });

  it("no figure where nothing was measured to that standard: other chains, the unmeasured direction, another wrapper contract", async () => {
    vi.stubGlobal("fetch", stub());
    const provider = wrapProvider({rpcUrls});
    // Monad reports the gas limit as gasUsed; Sonic's simulation is not gas used; MegaETH's wrap into an empty balance
    // (94 632) was above the 90 000 limit the table was measured against; zkSync, Gnosis, Berachain, Morph: no receipt
    // of both cases or no simulation; Flare, Avalanche, Plume, Elysium: not measured (the gas-limit estimates of
    // limits-2026-11-28.json are not a gas-used measurement).
    for (const id of [14, 100, 143, 146, 324, 2818, 4326, 43114, 80094, 98866, 99901]) {
      expect(WRAP_GAS[id], String(id)).toBeUndefined();
      for (const wrap of [true, false]) {
        const q = await provider.getQuote(params(id, wrap));
        expect(q, `${id} ${wrap}`).not.toBeNull();
        expect(q!.gasEstimate, `${id} ${wrap}`).toBeUndefined();
        expect(q!.gasEstimateSource, `${id} ${wrap}`).toBeUndefined();
      }
    }
    const mega = measured.chains["4326"]!.simulation as {depositIntoEmpty: number};
    expect(BigInt(mega.depositIntoEmpty) > GAS_LIMIT).toBe(true);
    expect(measured.chains["143"]!.receipts.withdraw.map((r) => r.gasUsed)).toContain(1_500_000);
    // Sei and Scroll: the wrap's dearer case was never seen in a receipt.
    for (const id of [1329, 534352]) {
      expect((await provider.getQuote(params(id, true)))!.gasEstimate).toBeUndefined();
      expect((await provider.getQuote(params(id, false)))!.gasEstimate).toBe(WRAP_GAS[id]!.unwrap);
    }
    // An overridden wrapper on a measured chain is another contract: its gas was not measured.
    const other = "0x1111111111111111111111111111111111111111";
    const custom = wrapProvider({rpcUrls, wrapped: {1: {address: other, symbol: "WETH"}}});
    const q = await custom.getQuote({...params(1, true), destToken: other});
    expect(q!.txRequest!.to).toBe(other);
    expect(q!.gasEstimate).toBeUndefined();
    // The table itself is frozen.
    expect(Object.isFrozen(WRAP_GAS) && Object.isFrozen(WRAP_GAS[1])).toBe(true);
    expect(wrapPins.spenders("eip155:1")).toEqual([]);
  });
});

describe("wrap gas limit: what the transaction is sent with, per chain", () => {
  it("every chain's limit is at least half again over the dearer eth_estimateGas figure of 2026-11-28", () => {
    for (const [id, m] of Object.entries(limits.chains)) {
      expect(Object.prototype.hasOwnProperty.call(WRAPPED_NATIVE, Number(id)), id).toBe(true);
      const dearer = Math.max(m.deposit, ...(m.withdraw ?? []));
      expect(BigInt(wrapGasLimit(Number(id))) * 2n >= BigInt(dearer) * 3n, `${id}: limit ${wrapGasLimit(Number(id))}, needs ${dearer}`).toBe(true);
    }
    // Before 2026-11-28 every chain went out with 90 000: Flare, zkSync, Sei and MegaETH needed more.
    for (const id of [14, 324, 1329, 4326]) expect(Math.max(limits.chains[id]!.deposit, ...(limits.chains[id]!.withdraw ?? [])) > Number(GAS_LIMIT), String(id)).toBe(true);
    expect(Object.keys(WRAP_GAS_LIMIT).map(Number).sort((a, b) => a - b)).toEqual([14, 324, 1329, 4326]);
    expect(Object.isFrozen(WRAP_GAS_LIMIT)).toBe(true);
  });

  it("every measured chain's gas figures fit under its limit, with the 90 000 default where the table names no chain", () => {
    for (const id of Object.keys(WRAPPED_NATIVE).map(Number)) {
      const limit = BigInt(wrapGasLimit(id));
      expect(limit >= GAS_LIMIT, String(id)).toBe(true);
      if (!Object.prototype.hasOwnProperty.call(WRAP_GAS_LIMIT, id)) expect(limit, String(id)).toBe(GAS_LIMIT);
      const entry = WRAP_GAS[id];
      if (entry?.wrap !== undefined) expect(BigInt(entry.wrap) <= limit, String(id)).toBe(true);
      if (entry?.unwrap !== undefined) expect(BigInt(entry.unwrap) <= limit, String(id)).toBe(true);
      const sim = measured.chains[String(id)]?.simulation;
      // Sonic's eth_simulateV1 answers millions (not gas used, README); its eth_estimateGas is in limits-2026-11-28.json.
      if (sim && "block" in sim && id !== 146) expect(BigInt(Math.max(sim.depositIntoEmpty, sim.withdrawPart)) <= limit, String(id)).toBe(true);
    }
    // An unknown chain id gets the default.
    expect(wrapGasLimit(999_999_999)).toBe("90000");
  });

  it("a quote and its built transaction carry the chain's limit: MegaETH, zkSync, Sei and Flare above 90 000", async () => {
    vi.stubGlobal("fetch", stub());
    const provider = wrapProvider({rpcUrls});
    for (const [id, limit] of [[4326, "200000"], [324, "500000"], [1329, "150000"], [14, "350000"], [1, "90000"], [8453, "90000"]] as const) {
      for (const wrap of [true, false]) {
        const q = await provider.getQuote(params(id, wrap));
        expect(q!.txRequest!.gasLimit, `${id} ${wrap}`).toBe(limit);
        expect(gasEstimateProblem(q!, `eip155:${id}`), `${id} ${wrap}`).toBeNull();
        expect((await provider.buildDeposit(q!)).gasLimit, `${id} ${wrap}`).toBe(limit);
      }
    }
  });
});

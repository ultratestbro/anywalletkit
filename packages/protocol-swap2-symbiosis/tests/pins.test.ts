// What an app pins when this provider runs on a backend (`remoteProvider({...symbiosisPinsFor(...)})`), and
// that every pinned contract is under the module watch.
import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {SYMBIOSIS_AGGREGATORS, SYMBIOSIS_CHAINS, SYMBIOSIS_HOST, SYMBIOSIS_REVERTER, SYMBIOSIS_UNWRAPPERS, SYMBIOSIS_V2_ROUTERS} from "../src/config.js";
import {SYMBIOSIS_HOST_FABRIC, SYMBIOSIS_HOST_META_ROUTER, SYMBIOSIS_POOLS, SYMBIOSIS_SYNTHS} from "../src/pools.js";
import {symbiosisPins, symbiosisPinsFor} from "../src/verify.js";
import {EVIL, EVM, lastOnly, quoteOf, rewrite} from "./fixtures.js";

const watch = JSON.parse(readFileSync(new URL("../watch.json", import.meta.url), "utf8")) as {module: string; sources: Record<string, unknown>[]};
const watched = JSON.stringify(watch).toLowerCase();

describe("symbiosis pins", () => {
  it("the only call target and the only spender on an EVM chain is that chain's MetaRouterGateway", () => {
    for (const [caip2, c] of Object.entries(SYMBIOSIS_CHAINS)) {
      const want = c!.family === "evm" ? [c!.gateway] : [];
      expect(symbiosisPins.callTargets(caip2), caip2).toEqual(want);
      expect(symbiosisPins.spenders(caip2), caip2).toEqual(want);
    }
    expect(symbiosisPins.callTargets("eip155:999999")).toEqual([]);
    // Tron, TON and Bitcoin have no EVM calldata: their builds are checked by verifyBuild, not by an address list.
    for (const chain of ["tron:728126428", "ton:-239", "bitcoin:mainnet"]) expect(symbiosisPins.callTargets(chain)).toEqual([]);
  });
  it("the deposit-address flag is there only for an app that switched Bitcoin sources on", () => {
    expect(symbiosisPins.depositAddressRoutes).toBeUndefined();
    expect(symbiosisPinsFor({btcSource: true}).depositAddressRoutes).toBe(true);
  });
  it("a backend's quote and build are checked by the same code as a local one", async () => {
    const {quote, recorded} = await quoteOf("eth-usdc-arb-usdc", {exchanges: lastOnly});
    const tx = {chain: "eip155:1", to: quote!.txRequest!.to!, value: "0", data: quote!.txRequest!.data!, chainId: 1, approvalAddress: quote!.txRequest!.approvalAddress!};
    expect(symbiosisPins.verifyQuote!(recorded.params, quote!)).toBeNull();
    expect(await symbiosisPins.verifyBuild!(quote!, tx, recorded.params)).toBeNull();
    const hostile = rewrite(quote!, (p) => { p.burn.chain2address = EVIL; });
    expect(symbiosisPins.verifyQuote!(recorded.params, hostile)).toMatch(/not the recipient/);
    expect(await symbiosisPins.verifyBuild!(quote!, {...tx, data: hostile.txRequest!.data!}, recorded.params)).toMatch(/not the recipient/);
    expect(await symbiosisPins.verifyBuild!(quote!, tx)).toMatch(/cannot be checked without the request/);
  });
  it("the user's own EVM address for Tron/TON routes comes from the app, not from the backend", async () => {
    const {quote, recorded} = await quoteOf("tron-usdt-ton-usdt", {exchanges: lastOnly});
    expect(symbiosisPins.verifyQuote!(recorded.params, quote!)).toMatch(/fallbackReceiver/);
    expect(symbiosisPinsFor({fallbackReceiver: EVM}).verifyQuote!(recorded.params, quote!)).toBeNull();
  });
  it("every pinned contract the watch can read is in watch.json", () => {
    const pins: string[] = [SYMBIOSIS_HOST.synthesis, SYMBIOSIS_HOST.bridge, SYMBIOSIS_HOST.multicallRouter, SYMBIOSIS_HOST_META_ROUTER, SYMBIOSIS_HOST_FABRIC, ...Object.values(SYMBIOSIS_AGGREGATORS)];
    // Tron contracts are not watched: the module watch has no Tron reader (README, "What is still trusted").
    // SYMBIOSIS_REVERTER is an account without code — there is nothing to hash.
    for (const c of Object.values(SYMBIOSIS_CHAINS)) if (c!.family === "evm") for (const a of [c!.gateway, c!.executor, c!.portal, c!.bridge]) if (a) pins.push(a);
    for (const r of Object.values(SYMBIOSIS_V2_ROUTERS)) pins.push(typeof r === "string" ? r : (r as {router: string}).router);
    for (const u of Object.values(SYMBIOSIS_UNWRAPPERS)) pins.push(u!.unwrapper);
    for (const pool of Object.keys(SYMBIOSIS_POOLS)) pins.push(pool);
    expect(watch.module).toBe("@anywalletkit/protocol-swap2-symbiosis");
    expect(pins.filter((a) => !watched.includes(a.toLowerCase()))).toEqual([]);
    expect(SYMBIOSIS_REVERTER).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // The pool index tables and the synthetic-token map are compared with the chain by `scripts/build-pins.mjs --check`;
    // the watch reads each pool's `lastIndex()` so a new asset shows up as a change.
    expect(Object.keys(SYMBIOSIS_SYNTHS).length).toBeGreaterThan(10);
    for (const pool of Object.keys(SYMBIOSIS_POOLS)) expect(watch.sources.some((s) => s.signature === "lastIndex()" && String(s.to).toLowerCase() === pool.toLowerCase()), pool).toBe(true);
  });
});

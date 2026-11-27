// The approval policy (2026-11-28): allowanceReuse "exact" | "sufficient" and revokeUnspentApproval, on the engine
// and per execution. Without them — or with "exact" + true — the engine is the published 0.17.0 call for call:
// GOLDEN_0_17_0 is the scenario matrix (tests/helpers/allowance-scenarios.ts) run against the 0.17.0 tarball from npm,
// a sha256 over every call each scenario makes (quotes, allowance reads, gas checks, sends with their payloads, waits,
// signatures, journal writes, reviews, phases, the outcome) and the calls in short. To regenerate it, run each scenario
// through `runScenario` with the `SingleProviderSwap2` of that build (`dist/swap2/single.js` of the npm tarball, its
// `@anywalletkit/*` and `viem` imports resolved to this workspace) and record `{sha256, calls}`.
import {describe, expect, it, vi} from "vitest";
import {Swap2ConfigurationError, Swap2Error, Swap2ExecutionError, Swap2MaybeSentError, Swap2QuoteError, Swap2ValidationError, refusal, refusalOf} from "../src/errors.js";
import {leftAllowanceOf, type Swap2ExecutionPlan} from "../src/swap2/base.js";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import * as index from "../src/index.js";
import {PERMIT2_ADDRESS} from "../src/permit2.js";
import {GPV2_VAULT_RELAYER} from "../src/swap2/gpv2.js";
import {AMOUNT, OTHER, ROUTER, SCENARIOS, USDC_BASE as USDC_BASE_CHECKSUM, USDC_ETH as USDC_ETH_CHECKSUM, USDT_ETH as USDT_ETH_CHECKSUM, runScenario, scenario, type EngineClass, type Run, type RunConfig, type Scenario} from "./helpers/allowance-scenarios.js";

// The engine names a token by the catalog's contract, lowercase (as in `approvals`).
const USDC_ETH = USDC_ETH_CHECKSUM.toLowerCase();
const USDT_ETH = USDT_ETH_CHECKSUM.toLowerCase();
const USDC_BASE = USDC_BASE_CHECKSUM.toLowerCase();
const Engine = SingleProviderSwap2 as unknown as EngineClass;
const run = (s: Scenario | string, cfg: RunConfig = {}) => runScenario(Engine, typeof s === "string" ? scenario(s) : s, cfg);
/** The calls of a run, phases left out. */
const calls = (r: Run) => r.summary.filter((line) => !line.startsWith("phase "));
/** The side effects only: what reached the account (sends, signatures) and the provider's order book. */
const effects = (r: Run) => r.summary.filter((line) => /^(approve|revoke|send|sign|register)\b/.test(line));
const SUFFICIENT = {engine: {allowanceReuse: "sufficient"}};
const KEEP = {engine: {revokeUnspentApproval: false}};
const plans = (r: Run) => r.log.filter((e) => e[0] === "review").map((e) => e[1] as Swap2ExecutionPlan & {reusedAllowance?: {token: string; spender: string; amount: string; chainId?: number}});

const GOLDEN_0_17_0: Record<string, {sha256: string; calls: string[]}> = {
  "usdc no allowance reader: approve, deposit": {sha256: "d0315f662357dae4f10336e9911401d66a988cbbff1e17b1bbd4352aca04a216", calls: ["quote #1", "review approvals=[1000000]", "approve router 1000000", "wait", "preflight", "send router 0xdeadbeef", "ok"]},
  "usdc allowance read fails: approve, deposit": {sha256: "52e4bb784d23aceb2a633bb8f0b7daf1c6c41c5bbc01771fbaf0b353812ca1ac", calls: ["quote #1", "allowance router", "review approvals=[1000000]", "approve router 1000000", "wait", "preflight", "send router 0xdeadbeef", "ok"]},
  "usdc zero allowance: approve, deposit": {sha256: "109ea6c32579d4becf30886b9eeb2596efab66be8795b28444c82ec4afd9d9a6", calls: ["quote #1", "allowance router", "review approvals=[1000000]", "estimate approve router 1000000", "estimate send router 0xdeadbeef +gas", "balance", "approve router 1000000", "wait", "preflight", "send router 0xdeadbeef", "ok"]},
  "usdc equal allowance: deposit only": {sha256: "d60f1e95e3a5e555161b65be5c8aa5d758d729e4771c6010f6f3c3de11eb6ddf", calls: ["quote #1", "allowance router", "review approvals=[]", "estimate send router 0xdeadbeef +gas", "balance", "preflight", "send router 0xdeadbeef", "ok"]},
  "usdc larger allowance: overwritten, deposit": {sha256: "109ea6c32579d4becf30886b9eeb2596efab66be8795b28444c82ec4afd9d9a6", calls: ["quote #1", "allowance router", "review approvals=[1000000]", "estimate approve router 1000000", "estimate send router 0xdeadbeef +gas", "balance", "approve router 1000000", "wait", "preflight", "send router 0xdeadbeef", "ok"]},
  "usdc smaller allowance: overwritten, deposit": {sha256: "52e4bb784d23aceb2a633bb8f0b7daf1c6c41c5bbc01771fbaf0b353812ca1ac", calls: ["quote #1", "allowance router", "review approvals=[1000000]", "approve router 1000000", "wait", "preflight", "send router 0xdeadbeef", "ok"]},
  "usdt stale allowance: reset, approve, deposit": {sha256: "14e5d3b18074facf10bc4cef5e0616ea90dbd48b564e10d8aff4416e683e551c", calls: ["quote #1", "allowance router", "review approvals=[0,1000000]", "revoke router", "wait", "approve router 1000000", "wait", "preflight", "send router 0xdeadbeef", "ok"]},
  "usdt larger allowance: reset, approve, deposit": {sha256: "14e5d3b18074facf10bc4cef5e0616ea90dbd48b564e10d8aff4416e683e551c", calls: ["quote #1", "allowance router", "review approvals=[0,1000000]", "revoke router", "wait", "approve router 1000000", "wait", "preflight", "send router 0xdeadbeef", "ok"]},
  "usdt zero allowance: one approve": {sha256: "a06403acac168f6d67e76c558a55ca21f4b921cd997b4b302f32a3de2400b07e", calls: ["quote #1", "allowance router", "review approvals=[1000000]", "approve router 1000000", "wait", "preflight", "send router 0xdeadbeef", "ok"]},
  "usdt no reader: reset, approve": {sha256: "6a837a17dbfdcdc60a4400b70915948940f33bf049b834527ce3c0881ae30b62", calls: ["quote #1", "review approvals=[0,1000000]", "revoke router", "wait", "approve router 1000000", "wait", "preflight", "send router 0xdeadbeef", "ok"]},
  "usdc larger allowance, deposit fails: revoked": {sha256: "c45096e4339d5c823f1bebbe63d07e7e5c730d177c9afa7e9fa18699c25ed829", calls: ["quote #1", "allowance router", "review approvals=[1000000]", "approve router 1000000", "wait", "preflight", "send router 0xdeadbeef", "revoke router", "wait", "error Error: network dropped"]},
  "usdt larger allowance, deposit fails: revoked": {sha256: "b5deb7d3f1163b4a0ce85298bff3cdbc5aa85a453d0d35e0ac075e83c9167b51", calls: ["quote #1", "allowance router", "review approvals=[0,1000000]", "revoke router", "wait", "approve router 1000000", "wait", "preflight", "send router 0xdeadbeef", "revoke router", "wait", "error Error: network dropped"]},
  "usdc zero allowance, preflight fails: revoked": {sha256: "841fc5754050d1fc542f33209f89153a974adfad0501b7199edbdba56fc20ad9", calls: ["quote #1", "allowance router", "review approvals=[1000000]", "approve router 1000000", "wait", "preflight", "revoke router", "wait", "error Error: halted"]},
  "usdc equal allowance, preflight fails: left alone": {sha256: "b0d0fae42394a5b27d9781d90e8d80f89e6110930cea3f76d29b9ee15d9e913e", calls: ["quote #1", "allowance router", "review approvals=[]", "preflight", "error Error: halted"]},
  "usdc smaller allowance, preflight fails: revoked to 0": {sha256: "841fc5754050d1fc542f33209f89153a974adfad0501b7199edbdba56fc20ad9", calls: ["quote #1", "allowance router", "review approvals=[1000000]", "approve router 1000000", "wait", "preflight", "revoke router", "wait", "error Error: halted"]},
  "usdc zero allowance, approval rejected": {sha256: "0ccf1d9330e4fee36a022e8c6180269a6e30ccc1992e46722a2ab4f95fbca54f", calls: ["quote #1", "allowance router", "review approvals=[1000000]", "approve router 1000000", "revoke router", "wait", "error Error: user rejected the request"]},
  "usdc zero allowance, approval answer lost": {sha256: "11702cc0d9c76990451e34f1dd222e8174a96d910946d5db7691244b3bb7cf74", calls: ["quote #1", "allowance router", "review approvals=[1000000]", "approve router 1000000", "revoke router", "wait", "error TypeError: fetch failed"]},
  "first review cancelled: nothing sent": {sha256: "96e1193862e178853df1184db8af9200bf5b13f90fca881d0d70e71d6222823d", calls: ["quote #1", "allowance router", "review approvals=[1000000]", "error Error: user cancelled"]},
  "quote expires while the approval mines: re-quote, deposit": {sha256: "01711a0c657e2f7c2a0f7e65d6394ecfd703c7f6896970ee3729a61dadadf232", calls: ["quote #1", "allowance router", "review approvals=[1000000]", "approve router 1000000", "wait", "quote #2", "preflight", "send router 0xdeadbeef", "ok"]},
  "re-quote reviewed again and cancelled: revoked": {sha256: "4dfff60283152077bc7b6013d84bac79e0f21c0a56c845a0f00a3872766708e2", calls: ["quote #1", "allowance router", "review approvals=[1000000]", "approve router 1000000", "wait", "quote #2", "review approvals=[] requoted", "revoke router", "wait", "error Error: user cancelled"]},
  "re-quote finds no route: revoked": {sha256: "1ac0cd9fd7abc163f0d4b58b7699cb7c4b65da7f852637d8bdc819f27665e8b1", calls: ["quote #1", "allowance router", "review approvals=[1000000]", "approve router 1000000", "wait", "quote #2", "revoke router", "wait", "error Swap2QuoteError: swap2: no route available for the requested pair"]},
  "re-quote moves the spender: revoked": {sha256: "640cb1b0ac433d33168167b8e32c9056fa5610c42c865c5e2182cbd28fe00f88", calls: ["quote #1", "allowance router", "review approvals=[1000000]", "approve router 1000000", "wait", "quote #2", "revoke router", "wait", "error Swap2QuoteError: swap2: the fresh quote moved the spender to 0x9999999999999999999999999999999999999999 — aborted, the allowance for 0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE was revoked"]},
  "dry run reverts once after the approval: re-quote, deposit": {sha256: "b645d7d12dbba1ec624b69dc41c493b1e27b5bbd1b3dec364eba78ac412fa5bd", calls: ["quote #1", "allowance router", "review approvals=[1000000]", "estimate approve router 1000000", "estimate send router 0xdeadbeef +gas", "balance", "approve router 1000000", "wait", "preflight", "estimate send router 0xdeadbeef", "quote #2", "estimate send router 0xdeadbeef +gas", "balance", "preflight", "estimate send router 0xdeadbeef", "send router 0xdeadbeef", "ok"]},
  "dry run reverts twice: revoked": {sha256: "3257975699c7fbb62ef8cb2405e295d34e2f42f0a7719ff41b4662546f8cb255", calls: ["quote #1", "allowance router", "review approvals=[1000000]", "estimate approve router 1000000", "estimate send router 0xdeadbeef +gas", "balance", "approve router 1000000", "wait", "preflight", "estimate send router 0xdeadbeef", "quote #2", "estimate send router 0xdeadbeef +gas", "balance", "preflight", "estimate send router 0xdeadbeef", "revoke router", "wait", "error Swap2ExecutionError: swap2: the swap does not simulate from this account (execution reverted: TooMuchSlippage) — nothing was sent"]},
  "permit2 zero allowance: approve, sign, send": {sha256: "83bd5ff22e30cc14c556b139e07030b908a9881016eff578cc1d5ef30083b982", calls: ["quote #1", "allowance permit2", "review approvals=[1000000]", "estimate approve permit2 1000000", "estimate send settler 0x1fff991f +gas", "balance", "approve permit2 1000000", "wait", "preflight", "sign PermitTransferFrom", "estimate send settler 0x1fff991f", "send settler 0x1fff991f", "ok"]},
  "permit2 covering allowance: sign, send": {sha256: "d03022b35ab7d4853cd10d4d469687bbc2a0990bafc2bcaec1e61e6c9fffb12a", calls: ["quote #1", "allowance permit2", "review approvals=[]", "estimate send settler 0x1fff991f +gas", "balance", "sign PermitTransferFrom", "preflight", "estimate send settler 0x1fff991f", "send settler 0x1fff991f", "ok"]},
  "permit2 smaller allowance, signature declined: left": {sha256: "abe31adb0a55e7c3652cec1e537450854349734a896f3e06c77301b6fac754e8", calls: ["quote #1", "allowance permit2", "review approvals=[1000000]", "estimate approve permit2 1000000", "estimate send settler 0x1fff991f +gas", "balance", "approve permit2 1000000", "wait", "preflight", "sign PermitTransferFrom", "error Error: user rejected the signature"]},
  "permit2 zero allowance, signed call reverts twice: left": {sha256: "292d3388c29bf49818c6c7072e042da68a992c9711d61317521817e2209f959a", calls: ["quote #1", "allowance permit2", "review approvals=[1000000]", "estimate approve permit2 1000000", "estimate send settler 0x1fff991f +gas", "balance", "approve permit2 1000000", "wait", "preflight", "sign PermitTransferFrom", "estimate send settler 0x1fff991f", "quote #2", "estimate send settler 0x1fff991f +gas", "balance", "sign PermitTransferFrom", "preflight", "estimate send settler 0x1fff991f", "error Swap2ExecutionError: swap2: the signed swap does not simulate from this account (execution reverted: TooMuchSlippage) — nothing was sent"]},
  "cow zero allowance: approve, sign, register": {sha256: "75544d7f0851ae91201b12a15ee7ccdbd83b904906baff85fd58dce95e860b59", calls: ["quote #1", "allowance relayer", "review approvals=[1000000]", "approve relayer 1000000", "wait", "preflight", "sign Order", "register", "ok"]},
  "cow sufficient target: sign, register": {sha256: "d03f472c2657e31043520d14617d5bfd4d643ad33d63d623e9d2f3602d13a1ea", calls: ["quote #1", "allowance relayer", "review approvals=[]", "preflight", "sign Order", "register", "ok"]},
  "cow partial allowance, register fails: restored": {sha256: "d6caa5d2a320aa0c790a4af44450a8ea79090655c8c64d17e6d1d6b61ba52827", calls: ["quote #1", "allowance relayer", "review approvals=[3000000]", "approve relayer 3000000", "wait", "preflight", "sign Order", "register", "approve relayer 500000", "wait", "error Error: orderbook down"]},
  "journaled: approve, deposit fails, revoked": {sha256: "a4771a38c0c97b88e8d7e6791b1e587db6ad1de1e8ae6aaa79c8aa6cef813b8e", calls: ["quote #1", "journal prepared", "allowance router", "review approvals=[1000000]", "journal running approval:pending", "approve router 1000000", "journal running approval:submitted", "wait", "preflight", "journal running source:pending", "send router 0xdeadbeef", "journal failed source:rejected", "journal running revoke:pending", "revoke router", "journal running revoke:submitted", "wait", "error Error: insufficient funds for gas"]},
  "journaled: equal allowance, deposit": {sha256: "3db5085e9f2920d85b4205fdb141b7739946f57e8b68d52ad0cc6450660340b0", calls: ["quote #1", "journal prepared", "allowance router", "review approvals=[]", "preflight", "journal running source:pending", "send router 0xdeadbeef", "journal submitted source:submitted", "ok"]},
};

describe("defaults are 0.17.0, call for call", () => {
  it("the matrix covers every scenario and nothing else", () => {
    expect(SCENARIOS.map((s) => s.name)).toEqual(Object.keys(GOLDEN_0_17_0));
  });
  for (const s of SCENARIOS) {
    it(s.name, async () => {
      const golden = GOLDEN_0_17_0[s.name]!;
      // Left out, "exact" + true on the engine, the same per execution, and the per-execution values over the opposite
      // engine values: every way of asking for the 0.17.0 behaviour produces exactly the 0.17.0 calls.
      for (const cfg of [
        {},
        {engine: {allowanceReuse: "exact", revokeUnspentApproval: true}},
        {execution: {allowanceReuse: "exact", revokeUnspentApproval: true}},
        {engine: {allowanceReuse: "sufficient", revokeUnspentApproval: false}, execution: {allowanceReuse: "exact", revokeUnspentApproval: true}},
      ] satisfies RunConfig[]) {
        const r = await run(s, cfg);
        expect(calls(r), JSON.stringify(cfg)).toEqual(golden.calls);
        expect(r.sha256, JSON.stringify(cfg)).toBe(golden.sha256);
        expect(leftAllowanceOf(r.error)).toBeUndefined();
      }
    });
  }
});

const LARGER = 500_000_000n; // the user's 500 000 FOLD on the Fynd router, here USDC on a pinned router
const larger = (over: Partial<Scenario> = {}): Scenario => ({name: "larger", provider: {kind: "call"}, account: {allowance: LARGER, gas: true}, ...over});
const failures: [string, Partial<Scenario>][] = [
  ["the provider's preflight fails", {provider: {kind: "call", preflight: () => new Error("halted")}}],
  ["the deposit fails", {account: {allowance: LARGER, gas: true, failSend: (k) => (k === "deposit" ? new Error("network dropped") : undefined)}}],
  ["the dry run reverts", {provider: {kind: "call", ownGasEstimate: true}, account: {allowance: LARGER, gas: true, dryRun: () => Object.assign(new Error("execution reverted"), {code: 3})}}],
  ["the quote expires before the broadcast", {provider: {kind: "call", ttlMs: () => 40, preflight: () => { vi.setSystemTime(Date.now() + 100); return undefined; }}}],
  ["the review is cancelled", {review: () => new Error("user cancelled")}],
];

describe("allowanceReuse: \"sufficient\"", () => {
  it("an allowance above the input: no approval, the swap spends the input from it, the plan and the result say so", async () => {
    const r = await run(larger(), SUFFICIENT);
    expect(effects(r)).toEqual(["send router 0xdeadbeef"]);
    const [plan] = plans(r);
    expect(plan!.approvals).toEqual([]);
    expect(plan!.reusedAllowance).toEqual({token: USDC_ETH, spender: ROUTER, amount: `${LARGER}n`, chainId: 1});
    expect(r.result!.reusedAllowance).toEqual({token: USDC_ETH, spender: ROUTER, amount: LARGER, chainId: 1});
    // The gas check counts no approval either.
    expect(calls(r).filter((c) => c.startsWith("estimate"))).toEqual(["estimate send router 0xdeadbeef +gas"]);
    // The same through the per-execution override, on a default engine.
    expect(effects(await run(larger(), {execution: {allowanceReuse: "sufficient"}}))).toEqual(["send router 0xdeadbeef"]);
  });

  for (const [why, over] of failures) {
    for (const revokeUnspentApproval of [true, false]) {
      it(`an allowance above the input is never approved, lowered or revoked when ${why} (revokeUnspentApproval ${revokeUnspentApproval})`, async () => {
        const r = await run(larger(over), {engine: {allowanceReuse: "sufficient", revokeUnspentApproval}});
        expect(r.error).toBeDefined();
        expect(effects(r).filter((e) => /^(approve|revoke)/.test(e))).toEqual([]);
        expect(leftAllowanceOf(r.error)).toBeUndefined(); // nothing of this execution's is left: it granted nothing
      });
    }
  }

  it("an allowance equal to the input: no approval, as before, and now reported", async () => {
    const r = await run(scenario("usdc equal allowance: deposit only"), SUFFICIENT);
    expect(effects(r)).toEqual(["send router 0xdeadbeef"]);
    expect(plans(r)[0]!.reusedAllowance).toEqual({token: USDC_ETH, spender: ROUTER, amount: `${AMOUNT}n`, chainId: 1});
    const failed = await run(scenario("usdc equal allowance, preflight fails: left alone"), SUFFICIENT);
    expect(effects(failed)).toEqual([]);
  });

  it("an allowance below the input is set to exactly the input, as before; when the swap does not go out it is put back, not zeroed", async () => {
    const ok = await run(scenario("usdc smaller allowance: overwritten, deposit"), SUFFICIENT);
    expect(effects(ok)).toEqual(effects(await run(scenario("usdc smaller allowance: overwritten, deposit"))));
    expect(effects(ok)).toEqual(["approve router 1000000", "send router 0xdeadbeef"]);
    expect(plans(ok)[0]!.reusedAllowance).toBeUndefined();
    expect(ok.result!.reusedAllowance).toBeUndefined();
    // exact: revoked to 0 (the user's 400 000 gone); sufficient: back to the 400 000 that was there.
    expect(effects(await run(scenario("usdc smaller allowance, preflight fails: revoked to 0")))).toEqual(["approve router 1000000", "revoke router"]);
    expect(effects(await run(scenario("usdc smaller allowance, preflight fails: revoked to 0"), SUFFICIENT))).toEqual(["approve router 1000000", "approve router 400000"]);
  });

  it("a zero allowance: exactly as \"exact\"", async () => {
    for (const name of ["usdc zero allowance: approve, deposit", "usdc zero allowance, preflight fails: revoked", "usdt zero allowance: one approve"]) {
      const exact = await run(name);
      const sufficient = await run(name, SUFFICIENT);
      expect(sufficient.sha256, name).toBe(exact.sha256);
    }
  });

  it("an allowance that cannot be read is refused before the review: nothing approved, lowered or revoked", async () => {
    // The read fails (a transient 429): it may well cover the input, so approving the input could lower it and a
    // failed swap would zero it. Refused, retryable, nothing reviewed or sent.
    for (const name of ["usdc allowance read fails: approve, deposit"]) {
      const r = await run(name, SUFFICIENT);
      expect(r.error, name).toBeInstanceOf(Swap2ExecutionError);
      expect(refusalOf(r.error), name).toEqual({reason: "upstream_unavailable"});
      expect((r.error as Error).message, name).toMatch(/allowanceReuse "sufficient" could not read the USDC allowance for 0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE — refused, nothing was sent/);
      expect((r.error as Error & {cause?: unknown}).cause, name).toMatchObject({message: "rpc down"});
      expect(calls(r).filter((c) => c.startsWith("review") || c.startsWith("estimate")), name).toEqual([]);
      expect(effects(r), name).toEqual([]);
      expect(leftAllowanceOf(r.error), name).toBeUndefined();
    }
    // The reviewer's case: 500 000 approved, a 429 on the read, the preflight would fail — no approve(input), no revoke.
    const user = await run({name: "read 429", provider: {kind: "call", preflight: () => new Error("halted")}, account: {allowance: "throws"}}, {engine: {allowanceReuse: "sufficient", revokeUnspentApproval: true}});
    expect(effects(user)).toEqual([]);
    // An account without getAllowance can never tell: a configuration error, every time.
    for (const name of ["usdc no allowance reader: approve, deposit", "usdt no reader: reset, approve"]) {
      const r = await run(name, SUFFICIENT);
      expect(r.error, name).toBeInstanceOf(Swap2ConfigurationError);
      expect((r.error as Error).message, name).toBe('swap2: allowanceReuse "sufficient" needs an account that reads allowances (getAllowance) — refused, nothing was sent');
      expect(effects(r), name).toEqual([]);
    }
    // The per-execution "exact" still approves as 0.17.0 did.
    const exact = await run("usdc allowance read fails: approve, deposit", {engine: {allowanceReuse: "sufficient"}, execution: {allowanceReuse: "exact"}});
    expect(exact.sha256).toBe(GOLDEN_0_17_0["usdc allowance read fails: approve, deposit"]!.sha256);
    // Permit2 keeps the "exact" rule for an unread allowance (it is never revoked after a signature transfer).
    const permit2 = {name: "permit2 unread", provider: {kind: "permit2"}, account: {allowance: "throws", gas: true}} satisfies Scenario;
    expect(calls(await run(permit2, SUFFICIENT))).toEqual(calls(await run(permit2)));
  });

  it("mainnet USDT: an allowance that covers the input is used without the reset; the reset only rides with an approval that is sent", async () => {
    const covered = await run({name: "usdt covered", token: "USDT", provider: {kind: "call"}, account: {allowance: LARGER}}, SUFFICIENT);
    expect(effects(covered)).toEqual(["send router 0xdeadbeef"]);
    expect(plans(covered)[0]!.reusedAllowance).toMatchObject({token: USDT_ETH, spender: ROUTER, amount: `${LARGER}n`});
    const stale = await run(scenario("usdt stale allowance: reset, approve, deposit"), SUFFICIENT);
    expect(effects(stale)).toEqual(["revoke router", "approve router 1000000", "send router 0xdeadbeef"]);
    // Put back after a failure: reset to 0, then the earlier 5 (USDT refuses non-zero → non-zero).
    const failed = await run({name: "usdt stale, fails", token: "USDT", provider: {kind: "call", preflight: () => new Error("halted")}, account: {allowance: 5n}}, SUFFICIENT);
    expect(effects(failed)).toEqual(["revoke router", "approve router 1000000", "revoke router", "approve router 5"]);
  });

  it("the spender is still the route's own: an allowance to another spender is not one this swap can use", async () => {
    // The account holds a covering allowance for OTHER only, none for the route's spender (ROUTER): the read is for
    // the route's spender, and the swap approves it as usual.
    const elsewhere = (spender: string) => (spender === "other" ? LARGER : 0n);
    const r = await run({name: "other spender", provider: {kind: "call"}, account: {allowance: elsewhere, gas: true}}, SUFFICIENT);
    expect(calls(r).filter((c) => c.startsWith("allowance"))).toEqual(["allowance router"]);
    expect(effects(r)).toEqual(["approve router 1000000", "send router 0xdeadbeef"]);
    expect(plans(r)[0]!.reusedAllowance).toBeUndefined();
    // The same allowance, read for the route's spender, is reused: the read decides, by spender.
    const there = await run({name: "route spender", provider: {kind: "call"}, account: {allowance: (spender) => (spender === "router" ? LARGER : 0n), gas: true}}, SUFFICIENT);
    expect(effects(there)).toEqual(["send router 0xdeadbeef"]);
  });

  it("a remote stub's unpinned spender is refused before any allowance is read, even with a covering allowance there", async () => {
    // Remote stub pinning ROUTER (spender and call target). The covering allowance is on OTHER, the spender the
    // backend names: policy_refused, no allowance read, nothing sent — in the quote, and in the build.
    const covering = () => LARGER;
    const pinned = {spenders: [ROUTER], callTargets: [ROUTER]};
    for (const [label, spec] of [
      ["the quote names it", {kind: "call", remote: pinned, tx: () => ({approvalAddress: OTHER})}],
      ["only the build names it", {kind: "call", remote: pinned, build: () => ({approvalAddress: OTHER})}],
    ] satisfies [string, Scenario["provider"]][]) {
      for (const cfg of [SUFFICIENT, {engine: {allowanceReuse: "sufficient", revokeUnspentApproval: false}}, {}] satisfies RunConfig[]) {
        const r = await run({name: `remote ${label}`, provider: spec, account: {allowance: covering, gas: true}}, cfg);
        expect(r.error, label).toBeDefined();
        expect(refusalOf(r.error)?.reason, label).toBe("policy_refused");
        expect(calls(r).filter((c) => /^(allowance|review|estimate|balance)/.test(c)), label).toEqual([]);
        expect(effects(r), label).toEqual([]);
        expect(leftAllowanceOf(r.error), label).toBeUndefined();
      }
    }
    // The pinned spender with the covering allowance is reused as usual.
    const ok = await run({name: "remote pinned", provider: {kind: "call", remote: pinned}, account: {allowance: covering, gas: true}}, SUFFICIENT);
    expect(effects(ok)).toEqual(["send router 0xdeadbeef"]);
    expect(plans(ok)[0]!.reusedAllowance).toMatchObject({spender: ROUTER, amount: `${LARGER}n`});
  });

  it("Permit2 signature transfers: the same calls as \"exact\"; a covering allowance is reported", async () => {
    for (const s of SCENARIOS.filter((x) => x.provider.kind === "permit2")) {
      const exact = await run(s);
      const sufficient = await run(s, SUFFICIENT);
      expect(calls(sufficient).filter((c) => !c.startsWith("review")), s.name).toEqual(calls(exact).filter((c) => !c.startsWith("review")));
      expect(plans(sufficient)[0]!.approvals, s.name).toEqual(plans(exact)[0]!.approvals);
    }
    const covered = await run(scenario("permit2 covering allowance: sign, send"), SUFFICIENT);
    expect(plans(covered)[0]!.reusedAllowance).toEqual({token: USDC_BASE, spender: PERMIT2_ADDRESS, amount: `${LARGER}n`, chainId: 8453});
  });

  it("CoW orders: the same calls as \"exact\"; a sufficient allowance target is reported", async () => {
    for (const s of SCENARIOS.filter((x) => x.provider.kind === "gpv2")) {
      const exact = await run(s);
      const sufficient = await run(s, SUFFICIENT);
      expect(calls(sufficient).filter((c) => !c.startsWith("review")), s.name).toEqual(calls(exact).filter((c) => !c.startsWith("review")));
    }
    const enough = await run(scenario("cow sufficient target: sign, register"), SUFFICIENT);
    expect(plans(enough)[0]!.reusedAllowance).toEqual({token: USDC_ETH, spender: GPV2_VAULT_RELAYER, amount: "5000000n", chainId: 1});
  });

  it("the per-execution value wins over the engine's", async () => {
    expect(effects(await run(larger(), {engine: {allowanceReuse: "sufficient"}, execution: {allowanceReuse: "exact"}}))).toEqual(["approve router 1000000", "send router 0xdeadbeef"]);
  });
});

describe("revokeUnspentApproval: false", () => {
  const LEFT = {token: USDC_ETH, spender: ROUTER, amount: AMOUNT, chainId: 1};

  it("the swap does not go out after its one re-quote: no revoke, the error says what is left", async () => {
    for (const name of ["re-quote finds no route: revoked", "dry run reverts twice: revoked"]) {
      const before = await run(name);
      expect(effects(before).at(-1), name).toBe("revoke router");
      const r = await run(name, KEEP);
      expect(effects(r), name).toEqual(effects(before).filter((e) => e !== "revoke router"));
      expect(leftAllowanceOf(r.error), name).toEqual(LEFT);
      expect((r.error as {leftAllowance?: unknown}).leftAllowance, name).toEqual(LEFT);
    }
    // The re-quote itself is unchanged: it still spends the allowance when it can.
    const requoted = await run("quote expires while the approval mines: re-quote, deposit", KEEP);
    expect(requoted.sha256).toBe(GOLDEN_0_17_0["quote expires while the approval mines: re-quote, deposit"]!.sha256);
    expect(requoted.result!.leftAllowance).toBeUndefined();
  });

  it("the second review is cancelled after the approval mined: no revoke, leftAllowance", async () => {
    const r = await run("re-quote reviewed again and cancelled: revoked", KEEP);
    expect(effects(r)).toEqual(["approve router 1000000"]);
    // The review's own error is the cause of a new Swap2ExecutionError with the same text; it is not modified.
    expect((r.error as Error).message).toBe("user cancelled");
    expect(r.error).toBeInstanceOf(Swap2ExecutionError);
    expect((r.error as {cause?: unknown}).cause).toBeInstanceOf(Error);
    expect(leftAllowanceOf((r.error as {cause?: unknown}).cause)).toBeUndefined();
    expect(leftAllowanceOf(r.error)).toEqual(LEFT);
  });

  it("a fresh quote that moved the spender: the first spender's allowance is left and named", async () => {
    const r = await run("re-quote moves the spender: revoked", KEEP);
    expect(effects(r)).toEqual(["approve router 1000000"]);
    expect(r.error).toBeInstanceOf(Swap2QuoteError);
    expect((r.error as Error).message).toBe(`swap2: the fresh quote moved the spender to ${OTHER} — aborted, the allowance for ${ROUTER} was left in place (revokeUnspentApproval: false)`);
    expect(leftAllowanceOf(r.error)).toEqual(LEFT);
  });

  it("a preflight, a deposit or a journaled deposit that fails: no revoke, leftAllowance, the error keeps its class", async () => {
    for (const name of ["usdc zero allowance, preflight fails: revoked", "usdc larger allowance, deposit fails: revoked", "journaled: approve, deposit fails, revoked"]) {
      const r = await run(name, KEEP);
      expect(effects(r).filter((e) => e.startsWith("revoke")), name).toEqual([]);
      expect(leftAllowanceOf(r.error), name).toEqual(LEFT);
      expect(r.error, name).toBeInstanceOf(Error);
    }
    const journaled = await run("journaled: approve, deposit fails, revoked", KEEP);
    expect(calls(journaled).filter((c) => c.includes("revoke"))).toEqual([]);
  });

  it("mainnet USDT: nothing is reset or revoked after a failure", async () => {
    const r = await run("usdt larger allowance, deposit fails: revoked", KEEP);
    expect(effects(r)).toEqual(["revoke router", "approve router 1000000", "send router 0xdeadbeef"]); // the reset before the approval only
    expect(leftAllowanceOf(r.error)).toEqual({...LEFT, token: USDT_ETH});
  });

  it("an approval refused before it was sent left nothing: no revoke, no leftAllowance; a lost answer may have, and is reported", async () => {
    const rejected = await run("usdc zero allowance, approval rejected", KEEP);
    expect(effects(rejected)).toEqual(["approve router 1000000"]);
    expect(leftAllowanceOf(rejected.error)).toBeUndefined();
    const lost = await run("usdc zero allowance, approval answer lost", KEEP);
    expect(effects(lost)).toEqual(["approve router 1000000"]);
    expect(leftAllowanceOf(lost.error)).toEqual(LEFT);
  });

  it("a deposit that may have been broadcast is not a left allowance (it may be spent), and nothing is revoked, as before", async () => {
    const r = await run({name: "maybe sent", provider: {kind: "call"}, account: {allowance: 0n, failSend: (k) => (k === "deposit" ? new TypeError("fetch failed") : undefined)}}, KEEP);
    expect(r.error).toBeInstanceOf(Swap2MaybeSentError);
    expect(effects(r)).toEqual(["approve router 1000000", "send router 0xdeadbeef"]);
    expect(leftAllowanceOf(r.error)).toBeUndefined();
  });

  it("a Permit2 signature transfer leaves its allowance either way, as before; with false it is reported", async () => {
    for (const name of ["permit2 smaller allowance, signature declined: left", "permit2 zero allowance, signed call reverts twice: left"]) {
      const before = await run(name);
      const r = await run(name, KEEP);
      expect(effects(r), name).toEqual(effects(before));
      expect(leftAllowanceOf(before.error), name).toBeUndefined();
      expect(leftAllowanceOf(r.error), name).toEqual({token: USDC_BASE, spender: PERMIT2_ADDRESS, amount: AMOUNT, chainId: 8453});
    }
  });

  it("a CoW order that is not placed: the allowance target stays instead of being put back", async () => {
    const before = await run("cow partial allowance, register fails: restored");
    expect(effects(before).at(-1)).toBe("approve relayer 500000");
    const r = await run("cow partial allowance, register fails: restored", KEEP);
    expect(effects(r)).toEqual(["approve relayer 3000000", "sign Order", "register"]);
    expect(leftAllowanceOf(r.error)).toEqual({token: USDC_ETH, spender: GPV2_VAULT_RELAYER, amount: 3_000_000n, chainId: 1});
  });

  it("a CoW order whose registration answer was lost may be live: its allowance is put back as before, not left", async () => {
    const lost: Scenario = {name: "cow lost", provider: {kind: "gpv2", approvalAmount: "3000000", register: () => new TypeError("fetch failed")}, account: {allowance: 500_000n}};
    const before = await run(lost);
    const r = await run(lost, KEEP);
    expect(r.sha256).toBe(before.sha256);
    expect(effects(r).at(-1)).toBe("approve relayer 500000");
    expect(leftAllowanceOf(r.error)).toBeUndefined();
  });

  it("with allowanceReuse \"sufficient\", an allowance that was there before is untouched by either value", async () => {
    for (const revokeUnspentApproval of [true, false]) {
      const r = await run(larger({provider: {kind: "call", preflight: () => new Error("halted")}}), {engine: {allowanceReuse: "sufficient", revokeUnspentApproval}});
      expect(effects(r)).toEqual([]);
      expect(leftAllowanceOf(r.error)).toBeUndefined();
    }
  });

  it("a successful swap carries no leftAllowance; the per-execution value wins over the engine's", async () => {
    const ok = await run("usdc zero allowance: approve, deposit", KEEP);
    expect(ok.result!.leftAllowance).toBeUndefined();
    expect(effects(await run("usdc zero allowance, preflight fails: revoked", {engine: {revokeUnspentApproval: false}, execution: {revokeUnspentApproval: true}}))).toEqual(["approve router 1000000", "revoke router"]);
    expect(effects(await run("usdc zero allowance, preflight fails: revoked", {execution: {revokeUnspentApproval: false}}))).toEqual(["approve router 1000000"]);
  });
});

describe("leftAllowance never modifies the thrown value", () => {
  const LEFT = {token: USDC_ETH, spender: ROUTER, amount: AMOUNT, chainId: 1};
  /** A re-quoted execution whose second review throws `thrown` (the first passes); the approval mined in between. */
  const secondReview = (thrown: unknown): Scenario => ({
    name: "second review throws", provider: {kind: "call", ttlMs: (n) => (n === 1 ? 40 : 60_000), tx: (n) => (n === 2 ? {data: "0xbadc0de5"} : {})},
    account: {allowance: 0n, mineMs: 100}, review: (n) => (n === 2 ? thrown as Error : undefined),
  });

  it("an app's module-level sentinel: untouched, never reported for a later swap, and the cause of what is thrown", async () => {
    const CANCELLED = new Error("user cancelled");
    // Run 1: the second review is cancelled after a mined approval — an allowance is left.
    const one = await run(secondReview(CANCELLED), KEEP);
    expect(leftAllowanceOf(one.error)).toEqual(LEFT);
    expect(one.error).not.toBe(CANCELLED);
    expect((one.error as {cause?: unknown}).cause).toBe(CANCELLED);
    expect(Object.prototype.hasOwnProperty.call(CANCELLED, "leftAllowance")).toBe(false);
    expect(leftAllowanceOf(CANCELLED)).toBeUndefined();
    // Run 2: the first review is cancelled, nothing approved: the sentinel itself comes back, with nothing left.
    const two = await run({name: "first review cancelled", provider: {kind: "call"}, account: {allowance: 0n}, review: () => CANCELLED}, KEEP);
    expect(two.error).toBe(CANCELLED);
    expect(leftAllowanceOf(two.error)).toBeUndefined();
    // Run 3: another left case — again a fresh error around the same, still clean, sentinel.
    const three = await run(secondReview(CANCELLED), KEEP);
    expect(three.error).not.toBe(one.error);
    expect((three.error as {cause?: unknown}).cause).toBe(CANCELLED);
    expect(leftAllowanceOf(three.error)).toEqual(LEFT);
    expect(Object.keys(CANCELLED)).toEqual([]);
  });

  it("a frozen error, a string, an object: wrapped with the same text, the original as cause", async () => {
    const frozen = Object.freeze(new Error("frozen cancel"));
    const f = await run(secondReview(frozen), KEEP);
    expect(f.error).toBeInstanceOf(Swap2ExecutionError);
    expect([(f.error as Error).message, (f.error as {cause?: unknown}).cause]).toEqual(["frozen cancel", frozen]);
    expect(leftAllowanceOf(f.error)).toEqual(LEFT);
    const text = await run(secondReview("nope"), KEEP);
    expect(text.error).toBeInstanceOf(Swap2ExecutionError);
    expect([(text.error as Error).message, (text.error as {cause?: unknown}).cause]).toEqual(["nope", "nope"]);
    expect(leftAllowanceOf(text.error)).toEqual(LEFT);
    // A refusal reason the thrown value carries comes along.
    const classified = refusal("policy_refused", "the app refused");
    const c = await run(secondReview(classified), KEEP);
    expect(refusalOf(c.error)).toEqual({reason: "policy_refused"});
    expect(Object.prototype.hasOwnProperty.call(classified, "leftAllowance")).toBe(false);
  });

  it("an engine error comes back as a copy of the same class, the original untouched", async () => {
    // A provider-thrown engine error, frozen and shared (a module-level sentinel of a provider package).
    const HALTED = Object.freeze(new Swap2ValidationError("swap2: halted by the venue", {reason: "chain_halted"}));
    const r = await run({name: "preflight sentinel", provider: {kind: "call", preflight: () => HALTED}, account: {allowance: 0n}}, KEEP);
    expect(effects(r)).toEqual(["approve router 1000000"]);
    expect(r.error).not.toBe(HALTED);
    expect(r.error).toBeInstanceOf(Swap2ValidationError);
    expect(r.error).toBeInstanceOf(Swap2Error);
    expect(r.error).toBeInstanceOf(Error);
    expect(Object.prototype.toString.call(r.error)).toBe("[object Error]");
    const e = r.error as Swap2ValidationError;
    expect([e.name, e.message, e.code]).toEqual(["Swap2ValidationError", "swap2: halted by the venue", "VALIDATION"]);
    expect(refusalOf(e)).toEqual({reason: "chain_halted"});
    expect(typeof e.stack).toBe("string");
    expect(leftAllowanceOf(e)).toEqual(LEFT);
    expect(Object.prototype.hasOwnProperty.call(HALTED, "leftAllowance")).toBe(false);
    // The engine's own errors keep their class: a quote error, and a may-have-been-sent approval (journaled).
    expect((await run("re-quote finds no route: revoked", KEEP)).error).toBeInstanceOf(Swap2QuoteError);
    const lost = await run({name: "journaled lost approval", provider: {kind: "call"}, account: {allowance: 0n, failSend: (k, i) => (k.startsWith("approve") && i === 0 ? new TypeError("fetch failed") : undefined)}, journal: true}, KEEP);
    expect(lost.error).toBeInstanceOf(Swap2MaybeSentError);
    expect((lost.error as Swap2MaybeSentError).maybeSent).toBe(true);
    expect(refusalOf(lost.error)).toBeUndefined();
    expect(leftAllowanceOf(lost.error)).toEqual(LEFT);
  });
});

describe("exactAllowanceOnly: a provider that keeps the defaults", () => {
  it("held: an allowance above the input is set to exactly the input and revoked when unspent, whatever the options say", async () => {
    const asked: string[] = [];
    const held = (over: Partial<Scenario["provider"]> = {}): Scenario => ({name: "held", provider: {kind: "call", exactAllowanceOnly: (chain) => { asked.push(chain); return true; }, ...over}, account: {allowance: LARGER, gas: true}});
    const both = {engine: {allowanceReuse: "sufficient", revokeUnspentApproval: false}};
    const ok = await run(held(), both);
    expect(effects(ok)).toEqual(["approve router 1000000", "send router 0xdeadbeef"]);
    expect(plans(ok)[0]!.reusedAllowance).toBeUndefined();
    expect(ok.result!.reusedAllowance).toBeUndefined();
    expect(asked).toEqual(["eip155:1"]);
    const failed = await run(held({preflight: () => new Error("halted")}), {execution: {allowanceReuse: "sufficient", revokeUnspentApproval: false}});
    expect(effects(failed)).toEqual(["approve router 1000000", "revoke router"]);
    expect(leftAllowanceOf(failed.error)).toBeUndefined();
    // The held run makes exactly the calls of a default run of the same scenario.
    const plain: Scenario = {name: "plain", provider: {kind: "call"}, account: {allowance: LARGER, gas: true}};
    expect(calls(ok)).toEqual(calls(await run(plain)));
    // A throw, or any answer but false, holds too; false does not.
    const thrown = await run({...held(), provider: {kind: "call", exactAllowanceOnly: () => { throw new Error("boom"); }}}, SUFFICIENT);
    expect(effects(thrown)).toEqual(["approve router 1000000", "send router 0xdeadbeef"]);
    const odd = await run({...held(), provider: {kind: "call", exactAllowanceOnly: () => undefined as never}}, SUFFICIENT);
    expect(effects(odd)).toEqual(["approve router 1000000", "send router 0xdeadbeef"]);
    const free = await run({...held(), provider: {kind: "call", exactAllowanceOnly: () => false}}, SUFFICIENT);
    expect(effects(free)).toEqual(["send router 0xdeadbeef"]);
  });

  it("with the defaults it is never asked: the 0.17.0 calls", async () => {
    let asked = 0;
    for (const s of SCENARIOS.filter((x) => x.provider.kind === "call").slice(0, 6)) {
      const r = await run({...s, provider: {...s.provider, exactAllowanceOnly: () => { asked++; return true; }}});
      expect(r.sha256, s.name).toBe(GOLDEN_0_17_0[s.name]!.sha256);
    }
    expect(asked).toBe(0);
  });

  it("revokeUnspentApproval: false alone is held too: the re-quote's failure revokes", async () => {
    const r = await run({...scenario("re-quote finds no route: revoked"), provider: {...scenario("re-quote finds no route: revoked").provider, exactAllowanceOnly: () => true}}, KEEP);
    expect(r.sha256).toBe(GOLDEN_0_17_0["re-quote finds no route: revoked"]!.sha256);
    expect(leftAllowanceOf(r.error)).toBeUndefined();
  });
});

describe("approval policy configuration", () => {
  it("a value outside the options is refused before anything is quoted or sent", async () => {
    for (const cfg of [
      {engine: {allowanceReuse: "partial"}}, {engine: {allowanceReuse: null}}, {execution: {allowanceReuse: "SUFFICIENT"}},
      {engine: {revokeUnspentApproval: "no"}}, {execution: {revokeUnspentApproval: 0}}, {engine: {revokeUnspentApproval: null}},
    ] satisfies RunConfig[]) {
      const r = await run("usdc zero allowance: approve, deposit", cfg);
      expect(r.error, JSON.stringify(cfg)).toBeInstanceOf(Swap2ConfigurationError);
      expect(calls(r).filter((c) => !c.startsWith("error")), JSON.stringify(cfg)).toEqual([]);
    }
  });

  it("leftAllowanceOf reads only a well-formed leftAllowance", () => {
    expect(leftAllowanceOf(undefined)).toBeUndefined();
    expect(leftAllowanceOf(new Error("x"))).toBeUndefined();
    expect(leftAllowanceOf({leftAllowance: {token: "0x1", spender: "0x2", amount: "5"}})).toBeUndefined();
    expect(leftAllowanceOf({leftAllowance: {token: "0x1", spender: "0x2", amount: 5n}})).toEqual({token: "0x1", spender: "0x2", amount: 5n});
    expect(index.leftAllowanceOf).toBe(leftAllowanceOf);
  });
});

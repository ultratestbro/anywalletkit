// The appData document: its bytes are what the order commits to, so they are pinned here to the byte.
import {describe, expect, it} from "vitest";
import {COW_APP_DATA_MAX_BYTES, COW_APP_DATA_VERSION, appDataHash, buildAppData, stableJson} from "../src/appdata.js";
import {COW_PERMIT_HOOK_GAS, placeholderPermitCall} from "../src/permit.js";
import {ME, USDC} from "./fixtures.js";

describe("appData", () => {
  it("hashing is keccak256 of the document's bytes — a real mainnet order's document gives its appData", () => {
    // fullAppData of mainnet eth-flow order 0x353efa4f… as the orderbook stores it; the order's appData is its hash.
    const real = '{"appCode":"Trust wallet","metadata":{"orderClass":{"orderClass":"market"},"partnerFee":[{"volumeBps":70,"recipient":"0xea5B5991f761Ced44Ffa99bEaCb72d691ee334ec"}],"quote":{"slippageBips":330,"smartSlippage":false}},"version":"1.8.0"}';
    expect(appDataHash(real)).toBe("0x9976c29708859db876eb50e59ae073dfab1ed881d41ab861c710aa6d2260d7bd");
  });

  it("the default document, byte for byte, and the hash the live orderbook confirmed for it", () => {
    const doc = buildAppData({slippageBps: 50});
    expect(doc.json).toBe('{"appCode":"AnyWalletKit","environment":"production","metadata":{"quote":{"slippageBips":50}},"version":"1.16.0"}');
    expect(doc.hash).toBe("0x1fc7dfb9bfb16e9ba1136920e86cb315962f298f72e605a4f4949828b53715da");
    expect(doc.hash).toBe(appDataHash(doc.json));
    expect(COW_APP_DATA_VERSION).toBe("1.16.0");
  });

  it("never names a partner fee, a referrer, a bridge or any hook but the permit", () => {
    const hook = {target: USDC, callData: placeholderPermitCall({owner: ME, value: "25000000", deadline: 1_800_000_000}), gasLimit: COW_PERMIT_HOOK_GAS.toString()};
    for (const doc of [buildAppData({slippageBps: 0}), buildAppData({slippageBps: 100, appCode: "My Wallet", permitHook: hook})]) {
      const parsed = JSON.parse(doc.json) as {metadata: Record<string, unknown>};
      expect(Object.keys(JSON.parse(doc.json) as object).sort()).toEqual(["appCode", "environment", "metadata", "version"]);
      expect(Object.keys(parsed.metadata).every((k) => k === "quote" || k === "hooks")).toBe(true);
      expect(doc.json).not.toMatch(/partnerFee|referrer|bridging|flashloan|post/);
    }
  });

  it("the permit hook is one pre-hook: the token as the target, its permit call, the gas limit — lowercase, sorted keys", () => {
    const callData = placeholderPermitCall({owner: ME, value: "25000000", deadline: 1_800_000_000});
    const doc = buildAppData({slippageBps: 50, permitHook: {target: USDC, callData: callData.toUpperCase().replace("0X", "0x"), gasLimit: "100000"}});
    expect(JSON.parse(doc.json)).toEqual({
      appCode: "AnyWalletKit", environment: "production", version: "1.16.0",
      metadata: {hooks: {pre: [{callData, gasLimit: "100000", target: USDC.toLowerCase()}]}, quote: {slippageBips: 50}},
    });
    expect(doc.json.indexOf('"callData"')).toBeLessThan(doc.json.indexOf('"gasLimit"'));
    expect(doc.json.indexOf('"hooks"')).toBeLessThan(doc.json.indexOf('"quote"'));
    expect(doc.json.length).toBeLessThan(COW_APP_DATA_MAX_BYTES);
    expect(doc.hash).not.toBe(buildAppData({slippageBps: 50}).hash);
  });

  it("the same input always gives the same bytes; another slippage or app code gives another hash", () => {
    expect(buildAppData({slippageBps: 50, appCode: "AnyWalletKit"})).toEqual(buildAppData({slippageBps: 50}));
    expect(buildAppData({slippageBps: 51}).hash).not.toBe(buildAppData({slippageBps: 50}).hash);
    expect(buildAppData({slippageBps: 50, appCode: "Other"}).hash).not.toBe(buildAppData({slippageBps: 50}).hash);
  });

  it("stableJson sorts keys at every level, keeps array order and drops undefined", () => {
    expect(stableJson({b: 1, a: {d: [3, {z: 1, y: 2}], c: undefined, b: "x"}})).toBe('{"a":{"b":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it("refuses an app code that could change the bytes, a slippage that is not whole bps, a malformed hook, an oversized document", () => {
    for (const appCode of ["", "x".repeat(51), 'a"b', "a\\b", "café", "a\nb"]) expect(() => buildAppData({slippageBps: 50, appCode}), appCode).toThrow(/appCode/);
    for (const slippageBps of [-1, 0.5, 10_001, NaN]) expect(() => buildAppData({slippageBps}), String(slippageBps)).toThrow(/slippage/);
    const hook = {target: USDC, callData: "0xd505accf", gasLimit: "100000"};
    expect(() => buildAppData({slippageBps: 50, permitHook: {...hook, target: "0x12"}})).toThrow(/target/);
    expect(() => buildAppData({slippageBps: 50, permitHook: {...hook, callData: "0x1"}})).toThrow(/calldata/);
    expect(() => buildAppData({slippageBps: 50, permitHook: {...hook, callData: "0x"}})).toThrow(/calldata/);
    for (const gasLimit of ["0", "-1", "1e5", "0x10", "1000000000"]) expect(() => buildAppData({slippageBps: 50, permitHook: {...hook, gasLimit}}), gasLimit).toThrow(/gas limit/);
    expect(() => buildAppData({slippageBps: 50, permitHook: {...hook, callData: `0x${"ab".repeat(600)}`}})).toThrow(/over this module's 1000-byte bound/);
  });
});

// UNISWAP-V4-RESEARCH §3.4–§3.5, §4: the pinned table, the byte values and the two incompatible UR struct layouts.
import {describe, expect, it} from "vitest";
import {decodeAbiParameters, encodeAbiParameters, getAddress, size, toFunctionSelector, type Hex} from "viem";
import {ccChain} from "@anywalletkit/swap2-assets";
import * as root from "../src/index.js";
import {
  PERMIT2_ADDRESS, SWAP_PROXY_ADDRESS, SWAP_PROXY_CODEHASH, SWAP_PROXY_EXECUTE_SELECTOR, UNISWAP_UR_SELECTORS, UNISWAP_V4, UR_ABI, UR_COMMANDS,
  UR_EXECUTE_NO_DEADLINE_SELECTOR, UR_EXECUTE_SELECTOR, UR_EXECUTE_SIGNED_SELECTOR, V4_ACTION_CONSTANTS, V4_ACTIONS, V4_EXACT_IN_ABI,
  V4_EXACT_IN_SINGLE_ABI, uniswapV4DeploymentOf,
} from "../src/v4/addresses.js";
import {decodeV4SwapCall} from "../src/v4/verify.js";
import {UNISWAP_V3} from "../src/addresses.js";
import {AUSD, AUSD_USDC_50_1, MON_AUSD_500_1, MON_USDC_500_10, NATIVE, UR20_EXACT_IN_ABI, UR20_EXACT_IN_SINGLE_ABI, e1, settle, take, urExecute, v4Input} from "./v4-helpers.js";

/** The catalog chains with a v4 deployment (decision 6: Soneium 1868, Tempo 4217, Zora 7777777 are not in the catalog). */
const CATALOG_V4 = [1, 10, 56, 130, 137, 143, 196, 480, 999, 4326, 4663, 5042, 8453, 42161, 42220, 43114, 57073, 59144, 99901];

describe("UNISWAP_V4 table (pins.json + pins-evidence.json, 2026-11-25)", () => {
  it("pins exactly the catalog v4 chains, each in the swap catalog", () => {
    expect(Object.keys(UNISWAP_V4).map(Number).sort((a, b) => a - b)).toEqual(CATALOG_V4);
    for (const id of CATALOG_V4) expect(ccChain(`eip155:${id}`), `chain ${id} in the catalog`).toBeDefined();
    for (const id of [1868, 4217, 7777777, 324]) expect(uniswapV4DeploymentOf(id)).toBeUndefined();
    expect(Object.isFrozen(UNISWAP_V4)).toBe(true);
  });

  it("every row is UR 2.1.2 with a codehash, the canonical SwapProxy and Permit2, checksummed addresses", () => {
    for (const [id, d] of Object.entries(UNISWAP_V4)) {
      expect(d.routerBuild, id).toBe("2.1.2");
      expect(d.routerCodehash, id).toMatch(/^0x[0-9a-f]{64}$/);
      expect(d.swapProxy, id).toBe(SWAP_PROXY_ADDRESS);
      expect(d.swapProxyCodehash, id).toBe(SWAP_PROXY_CODEHASH);
      expect(d.permit2, id).toBe(PERMIT2_ADDRESS);
      for (const a of [d.poolManager, d.quoter, d.stateView, d.positionManager, d.universalRouter, d.swapProxy, d.permit2, ...(d.weth ? [d.weth] : [])]) expect(getAddress(a), `${id} ${a}`).toBe(a);
      // The router codehash differs per chain (immutables): never one value for all.
    }
    expect(new Set(Object.values(UNISWAP_V4).map((d) => d.routerCodehash)).size).toBe(CATALOG_V4.length);
  });

  it("anchors: Monad (the trigger case), and the per-chain flags of decision 6", () => {
    const m = UNISWAP_V4[143]!;
    expect(m).toMatchObject({
      poolManager: "0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e",
      quoter: "0xa222Dd357A9076d1091Ed6Aa2e16C9742dD26891",
      stateView: "0x77395F3b2E73aE90843717371294fa97cC419D64",
      universalRouter: "0xa6CE4F10d83dBdDAc17E68e1837ca9cE6a1b596e",
      routerCodehash: "0xcb07a717d70f36cf270f1a6ed44163097e4dc8acbafb1d412cdb38f46af4b421",
      weth: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
    });
    // Same address, different contract: Monad's v3 QuoterV2 is UR 2.1.2 on Avalanche and Ink — keyed by chain.
    expect(UNISWAP_V3[143]!.quoter).toBe("0x661E93cca42AfacB172121EF892830cA3b70F08d");
    expect(UNISWAP_V4[43114]!.universalRouter).toBe("0x661E93cca42AfacB172121EF892830cA3b70F08d");
    expect(UNISWAP_V4[143]!.universalRouter).not.toBe(UNISWAP_V3[143]!.quoter);
    expect(UNISWAP_V4[999]!.quotable).toBe(false); // HyperEVM: no live quote
    expect(UNISWAP_V4[5042]).toMatchObject({weth: null, nativeWrap: false}); // Arc: native coin is USDC
    expect(UNISWAP_V4[42220]).toMatchObject({weth: "0x471EcE3750Da237f93B8E339c536989b8978a438", nativeWrap: false}); // Celo
    const flagged = Object.entries(UNISWAP_V4).filter(([, d]) => d.nativeWrap === false || d.quotable === false).map(([id]) => Number(id));
    expect(flagged.sort((a, b) => a - b)).toEqual([999, 5042, 42220]);
    expect(UNISWAP_V4[130]!.poolManager).toBe("0x1F98400000000000000000000000000000000004"); // Unichain
  });

  it("the root exports exactly the §5.4 v4 names", () => {
    for (const name of ["UNISWAP_V4", "UR_COMMANDS", "V4_ACTIONS", "uniswapV4VerifyQuote", "poolIdOf", "UNISWAP_UR_SELECTORS", "encodeV4Swap"]) expect(root, name).toHaveProperty(name);
    for (const name of ["decodeV4SwapCall", "V4_EXACT_IN_SINGLE_ABI", "classifyV4Revert"]) expect(root, name).not.toHaveProperty(name);
    // The v3 exports are unchanged.
    for (const name of ["UNISWAP_V3", "uniswapPins", "uniswapVerifyQuote", "uniswapProvider", "UniswapSwap2Protocol", "describeUniswapActivity", "UNISWAP_ROUTER_SELECTORS"]) expect(root, name).toHaveProperty(name);
  });
});

describe("selectors and byte values", () => {
  it("entry points", () => {
    expect(toFunctionSelector("function execute(bytes,bytes[],uint256)")).toBe(UR_EXECUTE_SELECTOR);
    expect(toFunctionSelector("function execute(bytes,bytes[])")).toBe(UR_EXECUTE_NO_DEADLINE_SELECTOR);
    expect(toFunctionSelector("function execute(address,address,uint256,bytes,bytes[],uint256)")).toBe(SWAP_PROXY_EXECUTE_SELECTOR);
    expect(UR_EXECUTE_SIGNED_SELECTOR).toBe("0x44684dc3");
    expect([...UNISWAP_UR_SELECTORS]).toEqual(["0x3593564c"]);
    expect(UR_ABI.filter((x) => x.type === "function" && x.name === "execute")).toHaveLength(1);
  });

  it("commands and actions (Commands.sol 2.1.2, Actions.sol 545a5d2)", () => {
    expect(UR_COMMANDS).toMatchObject({V3_SWAP_EXACT_IN: 0x00, SWEEP: 0x04, PERMIT2_PERMIT: 0x0a, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c, V4_SWAP: 0x10, V4_POSITION_MANAGER_CALL: 0x14, EXECUTE_SUB_PLAN: 0x21, ACROSS_V4_DEPOSIT_V3: 0x40});
    expect(V4_ACTIONS).toMatchObject({SWAP_EXACT_IN_SINGLE: 0x06, SWAP_EXACT_IN: 0x07, SWAP_EXACT_OUT_SINGLE: 0x08, SWAP_EXACT_OUT: 0x09, SETTLE: 0x0b, SETTLE_ALL: 0x0c, TAKE: 0x0e, TAKE_ALL: 0x0f, TAKE_PORTION: 0x10, SWEEP: 0x14, WRAP: 0x15, UNWRAP: 0x16, MINT_6909: 0x17, BURN_6909: 0x18});
    expect(V4_ACTION_CONSTANTS.CONTRACT_BALANCE).toBe(0x8000000000000000000000000000000000000000000000000000000000000000n);
    expect(new Set(Object.values(UR_COMMANDS)).size).toBe(Object.keys(UR_COMMANDS).length);
    expect(new Set(Object.values(V4_ACTIONS)).size).toBe(Object.keys(V4_ACTIONS).length);
  });
});

describe("the two struct layouts (UR 2.0 vs 2.1.x)", () => {
  const p20 = {poolKey: MON_AUSD_500_1, zeroForOne: true, amountIn: 100n * 10n ** 18n, amountOutMinimum: 1_089_996n, hookData: "0x" as Hex};
  const p21 = {...p20, minHopPriceX36: 0n};

  it("2.1.x single = 12 words with hookData at 0x140; 2.0 = 11 words with hookData at 0x120", () => {
    const a = encodeAbiParameters(V4_EXACT_IN_SINGLE_ABI, [p21]);
    const b = encodeAbiParameters(UR20_EXACT_IN_SINGLE_ABI, [p20]);
    expect(size(a)).toBe(12 * 32);
    expect(size(b)).toBe(11 * 32);
    expect(a.slice(2, 66)).toBe("20".padStart(64, "0")); // one dynamic tuple: data starts with 0x20
    expect(a.slice(2 + 10 * 64, 2 + 11 * 64)).toBe("140".padStart(64, "0"));
    expect(b.slice(2 + 9 * 64, 2 + 10 * 64)).toBe("120".padStart(64, "0"));
  });

  it("2.0 bytes read with the 2.1.x ABI shift words (the trap) — and never re-encode equal", () => {
    const b = encodeAbiParameters(UR20_EXACT_IN_SINGLE_ABI, [p20]);
    // viem decodes it "successfully" with minHopPriceX36 = 0x120 and an empty hookData: exactly what UR 2.1.2 executes.
    const [misread] = decodeAbiParameters(V4_EXACT_IN_SINGLE_ABI, b) as unknown as [{minHopPriceX36: bigint; hookData: Hex}];
    expect(misread.minHopPriceX36).toBe(0x120n);
    expect(misread.hookData).toBe("0x");
    expect(encodeAbiParameters(V4_EXACT_IN_SINGLE_ABI, [misread as never])).not.toBe(b);
  });

  it("2.1.x multi-hop read with the 2.0 ABI misreads amountIn (the 640 case) — and never re-encodes equal", () => {
    const path = [
      {intermediateCurrency: getAddress("0x754704bc059f8c67012fed69bc8a327a5aafb603"), fee: 500, tickSpacing: 10, hooks: NATIVE, hookData: "0x" as Hex},
      {intermediateCurrency: AUSD, fee: 50, tickSpacing: 1, hooks: NATIVE, hookData: "0x" as Hex},
    ];
    const a = encodeAbiParameters(V4_EXACT_IN_ABI, [{currencyIn: NATIVE, path, minHopPriceX36: [], amountIn: 10_000_000n, amountOutMinimum: 9_000_000n}]);
    const [misread] = decodeAbiParameters(UR20_EXACT_IN_ABI, a) as unknown as [{amountIn: bigint; amountOutMinimum: bigint}];
    expect(misread.amountIn).not.toBe(10_000_000n);
    expect(misread.amountOutMinimum).toBe(10_000_000n); // the real amountIn lands in the minimum, as live on UR 2.0
    expect(encodeAbiParameters(UR20_EXACT_IN_ABI, [misread as never])).not.toBe(a);
  });

  it("the strict decoder refuses the recorded 2.0-layout E1 calldata and a 2.0-layout two-hop", () => {
    const r = decodeV4SwapCall(e1.calldata_2_0);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.text).toMatch(/SWAP_EXACT_IN_SINGLE params are not the UR 2.1.x layout/);
    const path20 = encodeAbiParameters(UR20_EXACT_IN_ABI, [{currencyIn: NATIVE, path: [
      {intermediateCurrency: MON_USDC_500_10.currency1, fee: 500, tickSpacing: 10, hooks: NATIVE, hookData: "0x"},
      {intermediateCurrency: AUSD, fee: AUSD_USDC_50_1.fee, tickSpacing: 1, hooks: NATIVE, hookData: "0x"},
    ], amountIn: 100n * 10n ** 18n, amountOutMinimum: 1n}]);
    const r2 = decodeV4SwapCall(urExecute("0x10", [v4Input([0x07, 0x0b, 0x0e], [path20, settle(), take()])]));
    expect(r2.ok).toBe(false);
    expect(!r2.ok && r2.text).toMatch(/SWAP_EXACT_IN params are not the UR 2.1.x layout/);
  });
});

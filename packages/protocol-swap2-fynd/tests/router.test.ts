import {describe, expect, it} from "vitest";
import {encodeFunctionData, getAddress} from "viem";
import {FYND_CHAINS, FyndTransactionError, ROUTER_NATIVE, TYCHO_ROUTER_ABI, TYCHO_ROUTER_SELECTORS, checkFyndTransaction, fyndNativeSwaps, fyndPins} from "../src/router.js";
import {FYND_PREVIOUS_ROUTERS} from "../src/activity.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const USER = "0x1111111111111111111111111111111111111111";
const ROUTER = FYND_CHAINS[8453]!.router;
const NO_FEE = {clientFeeBps: 0, clientFeeReceiver: ZERO, maxClientContribution: 0n, deadline: 0n, clientSignature: "0x"} as const;

const expected = {chainId: 8453, tokenIn: USDC, tokenOut: WETH, amountIn: 1_000_000_000n, receiver: USER, expectedAmountOut: 250_000_000_000_000_000n, minAmountOut: 248_750_000_000_000_000n};

function single(over: Partial<{amountIn: bigint; tokenIn: string; tokenOut: string; expected: bigint; min: bigint; receiver: string; fee: typeof NO_FEE | Record<string, unknown>; swaps: `0x${string}`}> = {}) {
  return encodeFunctionData({
    abi: TYCHO_ROUTER_ABI,
    functionName: "singleSwap",
    args: [over.amountIn ?? expected.amountIn, (over.tokenIn ?? USDC) as `0x${string}`, (over.tokenOut ?? WETH) as `0x${string}`, over.expected ?? expected.expectedAmountOut, over.min ?? expected.minAmountOut, (over.receiver ?? USER) as `0x${string}`, (over.fee ?? NO_FEE) as never, over.swaps ?? "0xdeadbeef"],
  });
}

describe("checkFyndTransaction", () => {
  it("accepts the exact swap: pinned router, requested tokens, amount, receiver, quote amounts, no client fee", () => {
    expect(checkFyndTransaction({to: ROUTER, value: 0n, data: single()}, expected)).toEqual({method: "singleSwap"});
  });

  it("accepts split and sequential routes, and native input with the router's native sentinel", () => {
    const split = encodeFunctionData({abi: TYCHO_ROUTER_ABI, functionName: "splitSwap", args: [expected.amountIn, USDC, WETH, expected.expectedAmountOut, expected.minAmountOut, 3n, USER, NO_FEE as never, "0xbeef"]});
    expect(checkFyndTransaction({to: ROUTER, value: 0n, data: split}, expected).method).toBe("splitSwap");
    const native = single({tokenIn: ROUTER_NATIVE});
    expect(checkFyndTransaction({to: ROUTER, value: expected.amountIn, data: native}, {...expected, tokenIn: ZERO}).method).toBe("singleSwap");
  });

  const refusals: [string, () => unknown, RegExp][] = [
    ["another contract", () => checkFyndTransaction({to: "0x2222222222222222222222222222222222222222", value: 0n, data: single()}, expected), /not the Tycho router/],
    ["another receiver", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single({receiver: "0x3333333333333333333333333333333333333333"})}, expected), /pays 0x3333/],
    ["a bigger spend", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single({amountIn: expected.amountIn + 1n})}, expected), /spends/],
    ["other tokens", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single({tokenOut: USDC})}, expected), /other tokens/],
    ["a lower minimum than quoted", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single({min: 1n})}, expected), /do not match the quote/],
    ["a client fee", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single({fee: {...NO_FEE, clientFeeBps: 50, clientFeeReceiver: "0x4444444444444444444444444444444444444444"}})}, expected), /client-fee/],
    ["a client-fee receiver without bps (a signed deadline path this module does not sign)", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single({fee: {...NO_FEE, clientFeeReceiver: USER, deadline: 1n}})}, expected), /client-fee/],
    ["native value on an ERC-20 swap", () => checkFyndTransaction({to: ROUTER, value: 1n, data: single()}, expected), /native value/],
    ["an empty route", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single({swaps: "0x"})}, expected), /empty or invalid route/],
    ["a Permit2 variant", () => checkFyndTransaction({to: ROUTER, value: 0n, data: "0x12345678" + single().slice(10)}, expected), /not a plain/],
    ["an unpinned chain", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single()}, {...expected, chainId: 10}), /no pinned Tycho router/],
  ];
  for (const [name, run, msg] of refusals) {
    it(`refuses ${name}`, () => {
      expect(run).toThrow(FyndTransactionError);
      expect(run).toThrow(msg);
    });
  }

  it("knows all nine swap entry points for history", () => {
    expect(TYCHO_ROUTER_SELECTORS.size).toBe(9);
    expect(getAddress(ROUTER)).toBe("0xd374c00614f95492D816b5957E3797ce3f0c445C");
  });
});

// Propeller Heads paused every TychoRouterV3 on 2026-11-16 and redeployed it on every chain the same day
// (tycho registry commit 8aab890). Fynd's API builds to the new routers only; the paused ones must not pass.
describe("the 2026-11-16 router redeploy", () => {
  it("pins the redeployed router of the registry on every chain", () => {
    const registry: Record<number, string> = {
      1: "0xe41c726421007e133a59365432fE886a73B45126",
      8453: "0xd374c00614f95492D816b5957E3797ce3f0c445C",
      42161: "0x1B82e8C16Ce8E17535C9B6b8AD107f61b0b192B5",
      56: "0xEe7eCe626064BDA1c6aFDb8A281afe44Eabd3242",
      137: "0x4dB0B661dc706f7e09e54273028B22f61f8F94C2",
      130: "0x556dff14e4A42259ebCE4fa087323c1047e9a55A",
      4663: "0x6F460540B03651d2Ad0ec28f777e4A0480A756a5",
      5042: "0x52A1BC20F2B78461D7a03c32f6c7388D4587980f",
      99901: "0x643577F3b0cB8CE1b1b73C6E872b907aCACD2662",
    };
    expect(Object.fromEntries(Object.entries(FYND_CHAINS).map(([id, c]) => [id, getAddress(c.router)]))).toEqual(registry);
    for (const c of Object.values(FYND_CHAINS)) expect(c.router).toBe(getAddress(c.router));
  });

  it("refuses a swap built to the router it replaced, on every chain", () => {
    // Arc and Elysium joined after the redeploy: this module never pinned a router there before.
    expect(Object.keys(FYND_PREVIOUS_ROUTERS).sort()).toEqual(Object.keys(FYND_CHAINS).filter((id) => id !== "5042" && id !== "99901").sort());
    for (const [id, previous] of Object.entries(FYND_PREVIOUS_ROUTERS)) {
      expect(previous.length).toBeGreaterThan(0);
      for (const old of previous) {
        expect(sameAs(old, FYND_CHAINS[Number(id)]!.router)).toBe(false);
        const run = () => checkFyndTransaction({to: old, value: 0n, data: single()}, {...expected, chainId: Number(id)});
        expect(run).toThrow(FyndTransactionError);
        expect(run).toThrow(/not the Tycho router/);
      }
    }
  });
});

const sameAs = (a: string, b: string) => getAddress(a) === getAddress(b);

// Arc and Elysium, added 2026-11-17 on the registry's routers (verified: bytecode, paused() == false, live hosted-API
// quotes built to them). Their pre-redeploy routers were paused on 2026-11-16 and were never pinned here.
describe("Arc and Elysium", () => {
  const PAUSED = {5042: "0x72C452506a551C7fe069f1F66Beb671AC58909E9", 99901: "0xf7d2Ec960Cb9714C97897Db395Ff7f0a11de1060"} as const;
  const ARC_USDC = "0x3600000000000000000000000000000000000000";
  const ARC_EURC = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";
  const ELYSIUM_USDC = "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65";
  const arc = {...expected, chainId: 5042, tokenIn: ARC_USDC, tokenOut: ARC_EURC};
  const elysium = {...expected, chainId: 99901, tokenIn: ZERO, tokenOut: ELYSIUM_USDC};

  it("accepts the exact swap on each chain's router", () => {
    expect(FYND_CHAINS[5042]).toMatchObject({slug: "arc", name: "Arc"});
    expect(FYND_CHAINS[99901]).toMatchObject({slug: "elysium", name: "Elysium"});
    expect(checkFyndTransaction({to: FYND_CHAINS[5042]!.router, value: 0n, data: single({tokenIn: ARC_USDC, tokenOut: ARC_EURC})}, arc).method).toBe("singleSwap");
    // Elysium lists HYPE as its native coin: native input goes through with the router's sentinel.
    expect(checkFyndTransaction({to: FYND_CHAINS[99901]!.router, value: expected.amountIn, data: single({tokenIn: ROUTER_NATIVE, tokenOut: ELYSIUM_USDC})}, elysium).method).toBe("singleSwap");
  });

  it("refuses another chain's router and the paused pre-redeploy router", () => {
    for (const [id, paused] of Object.entries(PAUSED)) {
      const chainId = Number(id);
      for (const to of [paused, ROUTER]) {
        const run = () => checkFyndTransaction({to, value: 0n, data: single()}, {...expected, chainId});
        expect(run).toThrow(/not the Tycho router/);
      }
      expect(FYND_PREVIOUS_ROUTERS[chainId]).toBeUndefined();
      // remote quotes: the active router is the only call target and spender
      expect(fyndPins.callTargets(`eip155:${chainId}`)).toEqual([FYND_CHAINS[chainId]!.router]);
      expect(fyndPins.spenders(`eip155:${chainId}`)).toEqual([FYND_CHAINS[chainId]!.router]);
    }
    expect(fyndPins.callTargets("eip155:9745")).toEqual([]);
  });

  it("refuses Arc's native coin (USDC in 18-decimal units, not a catalog asset) on either side", () => {
    expect(fyndNativeSwaps(5042)).toBe(false);
    expect(fyndNativeSwaps(99901)).toBe(true);
    for (const id of [1, 8453, 42161, 56, 137, 130, 4663]) expect(fyndNativeSwaps(id)).toBe(true);
    const router = FYND_CHAINS[5042]!.router;
    const out = () => checkFyndTransaction({to: router, value: 0n, data: single({tokenIn: ARC_USDC, tokenOut: ROUTER_NATIVE})}, {...arc, tokenOut: ZERO});
    const sentinel = () => checkFyndTransaction({to: router, value: 0n, data: single({tokenIn: ARC_USDC, tokenOut: ROUTER_NATIVE})}, {...arc, tokenOut: ROUTER_NATIVE});
    const into = () => checkFyndTransaction({to: router, value: expected.amountIn, data: single({tokenIn: ROUTER_NATIVE, tokenOut: ARC_EURC})}, {...arc, tokenIn: ZERO});
    for (const run of [out, sentinel, into]) {
      expect(run).toThrow(FyndTransactionError);
      expect(run).toThrow(/native coin on Arc is not a catalog asset/);
    }
  });
});

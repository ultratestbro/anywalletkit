// Round trips of both router ABI families: address[11] routes with uint256[5][5] (+ _pools, _receiver) and
// uint256[4][5] (+ _receiver) params, and the selectors the module writes.
import {describe, expect, it} from "vitest";
import {decodeFunctionData, getAddress, parseAbi, toEventSelector, toFunctionSelector, type Hex} from "viem";
import {EXCHANGE_SELECTOR, EXCHANGE_TOPIC, GET_DY_SELECTOR, ROUTER_SELECTORS, decodeExchange, encodeExchange, encodeGetDy} from "../src/abi.js";
import {ZERO_ADDRESS} from "../src/deployments.js";
import {routeArgs, type CurveRoute} from "../src/routes.js";
import {ME, POOLS, TRIPOOL, TRICRYPTO_USDT, USDC, USDT, WETH, M_3POOL, M_USDC, M_USDT0} from "./fixtures.js";

const pool = (chain: number, a: string) => POOLS[chain]!.pools.find((p) => p.address.toLowerCase() === a.toLowerCase())!;

describe("router ABI", () => {
  it("selectors and Exchange topics are the signatures they claim", () => {
    expect(EXCHANGE_SELECTOR.ng5).toBe(toFunctionSelector("exchange(address[11],uint256[5][5],uint256,uint256,address[5],address)"));
    expect(EXCHANGE_SELECTOR.lite4).toBe(toFunctionSelector("exchange(address[11],uint256[4][5],uint256,uint256,address)"));
    expect(GET_DY_SELECTOR.ng5).toBe(toFunctionSelector("get_dy(address[11],uint256[5][5],uint256)"));
    expect(GET_DY_SELECTOR.lite4).toBe(toFunctionSelector("get_dy(address[11],uint256[4][5],uint256)"));
    expect([...ROUTER_SELECTORS.ng5]).toEqual(["exchange(address[11],uint256[5][5],uint256,uint256)", "exchange(address[11],uint256[5][5],uint256,uint256,address[5])", "exchange(address[11],uint256[5][5],uint256,uint256,address[5],address)"].map((s) => toFunctionSelector(s)));
    expect([...ROUTER_SELECTORS.lite4]).toEqual(["exchange(address[11],uint256[4][5],uint256,uint256)", "exchange(address[11],uint256[4][5],uint256,uint256,address)"].map((s) => toFunctionSelector(s)));
    expect(EXCHANGE_TOPIC.ng5).toBe(toEventSelector("Exchange(address,address,address[11],uint256[5][5],address[5],uint256,uint256)"));
    expect(EXCHANGE_TOPIC.lite4).toBe(toEventSelector("Exchange(address,address,address[11],uint256[4][5],uint256,uint256)"));
  });

  it("[5][5]: a two-step route encodes to address[11] + uint256[5][5] + zero _pools + receiver and decodes back", () => {
    const route: CurveRoute = {label: "", steps: [
      {kind: "pool", pool: pool(1, TRIPOOL), swapType: 1, i: 1, j: 2, tokenIn: getAddress(USDC) as Hex, tokenOut: getAddress(USDT) as Hex},
      {kind: "pool", pool: pool(1, TRICRYPTO_USDT), swapType: 1, i: 0, j: 2, tokenIn: getAddress(USDT) as Hex, tokenOut: WETH},
      {kind: "wrap", weth: WETH, tokenIn: WETH, tokenOut: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"},
    ]};
    const args = routeArgs("ng5", route);
    expect(args.route).toHaveLength(11);
    expect(args.params).toEqual([[1n, 2n, 1n, 1n, 3n], [0n, 2n, 1n, 30n, 3n], [0n, 0n, 8n, 0n, 0n], [0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n]]);
    const data = encodeExchange("ng5", args, 123n, 45n, ME);
    expect(data.slice(0, 10)).toBe("0xc872a3c5");
    const back = decodeExchange("ng5", data)!;
    expect(back).toMatchObject({amount: 123n, minDy: 45n, receiver: getAddress(ME), selector: "0xc872a3c5"});
    expect(back.route.map((a) => a.toLowerCase())).toEqual(args.route.map((a) => a.toLowerCase()));
    expect(back.params).toEqual(args.params);
    expect(back.pools).toEqual(Array(5).fill(ZERO_ADDRESS));
    const dy = decodeFunctionData({abi: parseAbi(["function get_dy(address[11], uint256[5][5], uint256)"]), data: encodeGetDy("ng5", args, 7n)});
    expect(dy.args[2]).toBe(7n);
  });

  it("[4][5]: uint256[4][5] params, no _pools, receiver last", () => {
    const route: CurveRoute = {label: "", steps: [{kind: "pool", pool: pool(143, M_3POOL), swapType: 1, i: 1, j: 2, tokenIn: getAddress(M_USDC) as Hex, tokenOut: getAddress(M_USDT0) as Hex}]};
    const args = routeArgs("lite4", route);
    expect(args.params[0]).toEqual([1n, 2n, 1n, 10n]);
    expect(args.params.every((r) => r.length === 4)).toBe(true);
    const data = encodeExchange("lite4", args, 10n, 9n, ME);
    expect(data.slice(0, 10)).toBe("0xfd44959c");
    const back = decodeExchange("lite4", data)!;
    expect(back).toMatchObject({amount: 10n, minDy: 9n, receiver: getAddress(ME), pools: null});
    expect(back.params).toEqual(args.params);
    // Wrong family: a [4][5] call is not a [5][5] call and vice versa.
    expect(decodeExchange("ng5", data)).toBeNull();
    expect(decodeExchange("lite4", encodeExchange("ng5", routeArgs("ng5", route), 10n, 9n, ME))).toBeNull();
  });

  it("refuses shapes that are not the family's", () => {
    const route: CurveRoute = {label: "", steps: [{kind: "pool", pool: pool(143, M_3POOL), swapType: 1, i: 1, j: 2, tokenIn: getAddress(M_USDC) as Hex, tokenOut: getAddress(M_USDT0) as Hex}]};
    expect(() => encodeExchange("ng5", routeArgs("lite4", route), 1n, 1n, ME)).toThrow(/uint256\[5\]\[5\]/);
    expect(decodeExchange("ng5", "0xdeadbeef")).toBeNull();
    expect(decodeExchange("ng5", "not hex")).toBeNull();
  });
});

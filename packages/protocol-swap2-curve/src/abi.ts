import {decodeFunctionData, encodeFunctionData, parseAbi} from "viem";
import type {CurveRouterFamily} from "./deployments.js";
import {ZERO_ADDRESS} from "./deployments.js";
import type {Hex} from "./pools/types.js";

/**
 * Router NG entry points, both ABI families (selectors with `viem toFunctionSelector`, checked against every pinned
 * router's code 2026-11-05). This module writes only the explicit-receiver `exchange` of each family and reads
 * `get_dy`; the other forms are listed for history recognition.
 */
export const ROUTER_NG5_ABI = parseAbi([
  "function exchange(address[11] _route, uint256[5][5] _swap_params, uint256 _amount, uint256 _min_dy) payable returns (uint256)",
  "function exchange(address[11] _route, uint256[5][5] _swap_params, uint256 _amount, uint256 _min_dy, address[5] _pools) payable returns (uint256)",
  "function exchange(address[11] _route, uint256[5][5] _swap_params, uint256 _amount, uint256 _min_dy, address[5] _pools, address _receiver) payable returns (uint256)",
  "function get_dy(address[11] _route, uint256[5][5] _swap_params, uint256 _amount) view returns (uint256)",
  "function version() view returns (string)",
]);
export const ROUTER_LITE4_ABI = parseAbi([
  "function exchange(address[11] _route, uint256[4][5] _swap_params, uint256 _amount, uint256 _min_dy) payable returns (uint256)",
  "function exchange(address[11] _route, uint256[4][5] _swap_params, uint256 _amount, uint256 _min_dy, address _receiver) payable returns (uint256)",
  "function get_dy(address[11] _route, uint256[4][5] _swap_params, uint256 _amount) view returns (uint256)",
  "function version() view returns (string)",
]);
export const VERSION_ABI = parseAbi(["function version() view returns (string)"]);
/** `coins(uint256)` (every NG pool and most plain ones) and `coins(int128)` (the oldest stable pools). */
export const COINS_UINT: Hex = "0xc6610657";
export const COINS_INT: Hex = "0x23746eb8";
export const ADDRESS_PROVIDER_ABI = parseAbi(["function get_address(uint256 _id) view returns (address)"]);

/** The `exchange` this module builds: with an explicit receiver. */
export const EXCHANGE_SELECTOR: Readonly<Record<CurveRouterFamily, Hex>> = Object.freeze({ng5: "0xc872a3c5", lite4: "0xfd44959c"});
export const GET_DY_SELECTOR: Readonly<Record<CurveRouterFamily, Hex>> = Object.freeze({ng5: "0x81889a2c", lite4: "0x11e21386"});
/** Every swap entry point per family, for history: `[5][5]` 4-, 5- and 6-argument forms; `[4][5]` 4- and 5-argument. */
export const ROUTER_SELECTORS: Readonly<Record<CurveRouterFamily, ReadonlySet<string>>> = Object.freeze({
  ng5: new Set(["0x371dc447", "0x5c9c18e2", "0xc872a3c5"]),
  lite4: new Set(["0xaad348a2", "0xfd44959c"]),
});
/** topic0 of the router's `Exchange` event per family (`[5][5]` logs `pools` too). */
export const EXCHANGE_TOPIC: Readonly<Record<CurveRouterFamily, Hex>> = Object.freeze({
  ng5: "0x56d0661e240dfb199ef196e16e6f42473990366314f0226ac978f7be3cd9ee83",
  lite4: "0x6324485a21bc5138ec352d4949d0adc75d8e1382a687e1aa1ce6863f40c9e463",
});

/** A route as the router takes it: 11 addresses and one swap-params row per step (5 rows; 5 or 4 columns). */
export interface RouterArgs {
  route: readonly Hex[];
  params: readonly (readonly bigint[])[];
}

/** One router call, decoded. `receiver` is null when the call names none (the router then pays `msg.sender`). */
export interface DecodedExchange extends RouterArgs {
  amount: bigint;
  minDy: bigint;
  pools: readonly Hex[] | null;
  receiver: Hex | null;
  selector: Hex;
}

const ZERO_POOLS: readonly Hex[] = Object.freeze([ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS]);
type Row5 = readonly [bigint, bigint, bigint, bigint, bigint];
type Row4 = readonly [bigint, bigint, bigint, bigint];
const tuple11 = (a: readonly Hex[]) => a as unknown as readonly [Hex, Hex, Hex, Hex, Hex, Hex, Hex, Hex, Hex, Hex, Hex];
const rows5 = (p: readonly (readonly bigint[])[]) => p as unknown as readonly [Row5, Row5, Row5, Row5, Row5];
const rows4 = (p: readonly (readonly bigint[])[]) => p as unknown as readonly [Row4, Row4, Row4, Row4, Row4];
const pools5 = (a: readonly Hex[]) => a as unknown as readonly [Hex, Hex, Hex, Hex, Hex];

function checkShape(family: CurveRouterFamily, args: RouterArgs): void {
  const cols = family === "ng5" ? 5 : 4;
  if (args.route.length !== 11 || args.params.length !== 5 || args.params.some((r) => r.length !== cols)) {
    throw new Error(`curve: a ${family} route is address[11] and uint256[${cols}][5]`);
  }
}

/** `exchange(route, params, amount, minDy, [zero pools,] receiver)` for the router family. */
export function encodeExchange(family: CurveRouterFamily, args: RouterArgs, amount: bigint, minDy: bigint, receiver: Hex): Hex {
  checkShape(family, args);
  return family === "ng5"
    ? encodeFunctionData({abi: ROUTER_NG5_ABI, functionName: "exchange", args: [tuple11(args.route), rows5(args.params), amount, minDy, pools5(ZERO_POOLS), receiver]})
    : encodeFunctionData({abi: ROUTER_LITE4_ABI, functionName: "exchange", args: [tuple11(args.route), rows4(args.params), amount, minDy, receiver]});
}

/** `get_dy(route, params, amount)` for the router family. */
export function encodeGetDy(family: CurveRouterFamily, args: RouterArgs, amount: bigint): Hex {
  checkShape(family, args);
  return family === "ng5"
    ? encodeFunctionData({abi: ROUTER_NG5_ABI, functionName: "get_dy", args: [tuple11(args.route), rows5(args.params), amount]})
    : encodeFunctionData({abi: ROUTER_LITE4_ABI, functionName: "get_dy", args: [tuple11(args.route), rows4(args.params), amount]});
}

/** Any of the family's `exchange` forms, decoded; null for anything else (another selector, malformed data). */
export function decodeExchange(family: CurveRouterFamily, data: string): DecodedExchange | null {
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase() as Hex;
  if (!ROUTER_SELECTORS[family].has(selector)) return null;
  try {
    if (family === "ng5") {
      const c = decodeFunctionData({abi: ROUTER_NG5_ABI, data: data as Hex});
      if (c.functionName !== "exchange") return null;
      const a = c.args as readonly unknown[];
      return {
        selector,
        route: a[0] as readonly Hex[],
        params: a[1] as readonly (readonly bigint[])[],
        amount: a[2] as bigint,
        minDy: a[3] as bigint,
        pools: a.length >= 5 ? (a[4] as readonly Hex[]) : null,
        receiver: a.length >= 6 ? (a[5] as Hex) : null,
      };
    }
    const c = decodeFunctionData({abi: ROUTER_LITE4_ABI, data: data as Hex});
    if (c.functionName !== "exchange") return null;
    const a = c.args as readonly unknown[];
    return {
      selector,
      route: a[0] as readonly Hex[],
      params: a[1] as readonly (readonly bigint[])[],
      amount: a[2] as bigint,
      minDy: a[3] as bigint,
      pools: null,
      receiver: a.length >= 5 ? (a[4] as Hex) : null,
    };
  } catch {
    return null;
  }
}

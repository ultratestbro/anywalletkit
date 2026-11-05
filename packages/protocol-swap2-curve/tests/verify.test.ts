// The checks a Curve quote's router call must pass (research doc §5.3): one adversarial case per rule, each built as the
// calldata a hostile backend could send, against the fixture allowlist.
import {afterEach, describe, expect, it, vi} from "vitest";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {encodeFunctionData, getAddress, parseAbi, type Hex} from "viem";
import {encodeExchange, type RouterArgs} from "../src/abi.js";
import {CURVE_DEPLOYMENTS, CURVE_ETH, ZERO_ADDRESS, type CurveDeployment} from "../src/deployments.js";
import {curveProvider} from "../src/provider.js";
import {curvePins, curveQuoteCheck, curveRemotePins} from "../src/verify.js";
import {BROKEN_ALETH, CRVUSD, CRVUSD_USDC, D1, D143, D42161, DEPLOYMENTS, FAKE_USDT, FAKE_USDT_POOL, M_3POOL, M_AUSD, M_OLD_STABLE, M_USDC, ME, OTHER, POOLS, RPC, SCRVUSD, STETH_NG, TABLES, TRICRYPTO_USDT, TRIPOOL, UNLISTED_POOL, USDC, USDT, WETH, rpcStub} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const verify = curveQuoteCheck(TABLES);
const Z = ZERO_ADDRESS;
const AMOUNT = 1_000_000_000n;
const MIN = 990_000_000n;

/** Router args from steps [[tokenIn, swap, tokenOut, row], …]. */
function args(family: "ng5" | "lite4", steps: readonly [string, string, string, readonly bigint[]][]): RouterArgs {
  const route: Hex[] = [getAddress(steps[0]![0]) as Hex];
  const params: bigint[][] = [];
  for (const [, swap, out, row] of steps) { route.push(getAddress(swap) as Hex, getAddress(out) as Hex); params.push([...row]); }
  while (route.length < 11) route.push(Z);
  while (params.length < 5) params.push(new Array<bigint>(family === "ng5" ? 5 : 4).fill(0n));
  return {route, params};
}
function quoteFor(d: CurveDeployment, a: RouterArgs, o: {amount?: bigint; min?: bigint; receiver?: string; value?: string; approval?: string | null; to?: string; data?: Hex} = {}): Quote {
  const min = o.min ?? MIN;
  return {
    provider: "curve", intentId: `curve:${Object.entries(DEPLOYMENTS).find(([, x]) => x === d)![0]}`, depositAddress: "", depositMemo: null,
    txRequest: {
      to: o.to ?? d.router,
      data: o.data ?? encodeExchange(d.family, a, o.amount ?? AMOUNT, min, getAddress(o.receiver ?? ME) as Hex),
      value: o.value ?? "0",
      ...(o.approval === null ? {} : {approvalAddress: o.approval ?? d.router}),
    },
    sourceAmount: AMOUNT.toString(), destAmount: "999000000", minDestAmount: min.toString(),
    feeUsd: 0, etaSeconds: 15, reliability: 0.97, validUntilMs: Date.now() + 60_000,
  };
}
const p1 = (over: Partial<QuoteParams> = {}): QuoteParams => ({sourceChain: "eip155:1", destChain: "eip155:1", sourceToken: "USDC", destToken: USDT, amountIn: AMOUNT.toString(), destAddress: ME, ...over});
const USDC_USDT = args("ng5", [[USDC, TRIPOOL, USDT, [1n, 2n, 1n, 1n, 3n]]]);

describe("curveVerifyQuote: what passes", () => {
  it("the explicit-receiver exchange through an allowlisted pool, exact input, the quote's minimum, paid to the recipient", () => {
    expect(verify(p1(), quoteFor(D1, USDC_USDT))).toBeNull();
  });
  it("native in: value is exactly the input and there is no approval", () => {
    const a = args("ng5", [[CURVE_ETH, WETH, WETH, [0n, 0n, 8n, 0n, 0n]], [WETH, TRICRYPTO_USDT, USDT, [2n, 0n, 1n, 30n, 3n]]]);
    expect(verify(p1({sourceToken: "ETH"}), quoteFor(D1, a, {value: AMOUNT.toString(), approval: null}))).toBeNull();
    expect(verify(p1({sourceToken: "ETH"}), quoteFor(D1, a, {value: "0", approval: null}))).toMatch(/native input is paid as exactly the input/);
    expect(verify(p1({sourceToken: "ETH"}), quoteFor(D1, a, {value: AMOUNT.toString()}))).toMatch(/native input is paid as exactly the input in value, with no approval/);
  });
  it("crvUSD → scrvUSD through the pinned vault on Ethereum's v1.2 router", () => {
    const a = args("ng5", [[CRVUSD, SCRVUSD, SCRVUSD, [0n, 0n, 9n, 0n, 0n]]]);
    expect(verify(p1({sourceToken: CRVUSD, sourceDecimals: 18, destToken: SCRVUSD}), quoteFor(D1, a))).toBeNull();
  });
});

describe("curveVerifyQuote: §5.3 H — what must be refused", () => {
  it("the registered fake-USDT pool (0xA6d9…1f53), even when an allowlist lists it", () => {
    const a = args("ng5", [[USDC, TRIPOOL, USDT, [1n, 2n, 1n, 1n, 3n]], [USDT, FAKE_USDT_POOL, FAKE_USDT, [1n, 0n, 1n, 10n, 2n]]]);
    expect(verify(p1({destToken: FAKE_USDT}), quoteFor(D1, a))).toMatch(/refuses \(fake coin, drained in 2023, or over a dead venue\)/);
  });
  it("the pools drained in 2023 (alETH, pETH, msETH), even when an allowlist lists one", () => {
    const a = args("ng5", [[CURVE_ETH, BROKEN_ALETH, "0x0100546F2cD4C9D97f798fFC9755E47865FF7Ee6", [0n, 1n, 1n, 1n, 2n]]]);
    expect(verify(p1({sourceToken: "ETH", destToken: "0x0100546F2cD4C9D97f798fFC9755E47865FF7Ee6"}), quoteFor(D1, a, {value: AMOUNT.toString(), approval: null}))).toMatch(/refuses/);
  });
  it("a pool that is not in the allowlist", () => {
    const a = args("ng5", [[USDT, UNLISTED_POOL, CRVUSD, [0n, 1n, 1n, 1n, 2n]]]);
    expect(verify(p1({sourceToken: "USDT", destToken: CRVUSD}), quoteFor(D1, a))).toMatch(/not in the pool allowlist/);
  });
  it("an allowlisted pool used with indexes that are not the hop's tokens, another pool type or coin count", () => {
    expect(verify(p1(), quoteFor(D1, args("ng5", [[USDC, TRIPOOL, USDT, [0n, 2n, 1n, 1n, 3n]]])))).toMatch(/coins 0\/2 are not the hop's tokens/);
    expect(verify(p1(), quoteFor(D1, args("ng5", [[USDC, TRIPOOL, USDT, [1n, 2n, 1n, 10n, 3n]]])))).toMatch(/pool_type 10, not pool 3pool's 1/);
    expect(verify(p1(), quoteFor(D1, args("ng5", [[USDC, TRIPOOL, USDT, [1n, 2n, 1n, 1n, 2n]]])))).toMatch(/names 2 coins/);
    expect(verify(p1(), quoteFor(D1, args("ng5", [[USDC, TRIPOOL, USDT, [1n, 2n, 2n, 1n, 3n]]])))).toMatch(/swap_type 2, which pool 3pool does not allow/);
  });
  it("a receiver other than the recipient, and the forms without a receiver (the router pays msg.sender)", () => {
    expect(verify(p1(), quoteFor(D1, USDC_USDT, {receiver: OTHER}))).toMatch(/pays 0x9999.*not the recipient/i);
    const R5 = parseAbi(["function exchange(address[11] _route, uint256[5][5] _swap_params, uint256 _amount, uint256 _min_dy, address[5] _pools) payable returns (uint256)"]);
    const noReceiver = encodeFunctionData({abi: R5, functionName: "exchange", args: [USDC_USDT.route as never, USDC_USDT.params as never, AMOUNT, MIN, [Z, Z, Z, Z, Z]]});
    expect(verify(p1(), quoteFor(D1, USDC_USDT, {data: noReceiver}))).toMatch(/selector 0x5c9c18e2 is not the explicit-receiver exchange/);
  });
  it("min_dy = 0, or a minimum other than the quote's", () => {
    const q = quoteFor(D1, USDC_USDT, {min: 0n});
    expect(verify(p1(), q)).toMatch(/no minimum \(min_dy 0\)/);
    const lower = {...quoteFor(D1, USDC_USDT, {min: 1n}), minDestAmount: MIN.toString()};
    expect(verify(p1(), lower)).toMatch(/minimum 1 is not the quote's/);
  });
  it("an approval to anything but the pinned router, or none, for a token input; value with a token input", () => {
    expect(verify(p1(), quoteFor(D1, USDC_USDT, {approval: OTHER}))).toMatch(/approves exactly the Curve router/);
    expect(verify(p1(), quoteFor(D1, USDC_USDT, {approval: null}))).toMatch(/approves exactly the Curve router/);
    expect(verify(p1(), quoteFor(D1, USDC_USDT, {value: "1"}))).toMatch(/attaches no value/);
  });
  it("a quote naming another chain than the request's (its on-chain checks and tracking would run there)", () => {
    // The same router address serves OP Mainnet, Polygon, Gnosis and Avalanche.
    const a = args("ng5", [[USDC, TRIPOOL, USDT, [1n, 2n, 1n, 1n, 3n]]]);
    expect(verify(p1(), {...quoteFor(D1, a), intentId: "curve:137"})).toMatch(/names curve:137, not curve:1/);
  });
  it("a call to anything but the pinned router (an older router included), selling another amount", () => {
    expect(verify(p1(), quoteFor(D1, USDC_USDT, {to: "0x16C6521Dff6baB339122a0FE25a9116693265353"}))).toMatch(/not the Curve router/);
    expect(verify(p1(), quoteFor(D1, USDC_USDT, {amount: AMOUNT - 1n}))).toMatch(/sells 999999999, not the 1000000000 input/);
  });
  it("swap_type 9 on a v1.1 router or a [4][5] router — even with a vault configured there", () => {
    const vault = {vault: SCRVUSD as Hex, asset: CRVUSD as Hex};
    const v11 = {...D42161, erc4626: vault};
    const lite = {...D143, erc4626: vault};
    const tables = {deployments: {...DEPLOYMENTS, 42161: v11, 143: lite}, pools: POOLS};
    const check = curveQuoteCheck(tables);
    const a5 = args("ng5", [[CRVUSD, SCRVUSD, SCRVUSD, [0n, 0n, 9n, 0n, 0n]]]);
    const q5 = {...quoteFor(D42161, a5), intentId: "curve:42161", txRequest: {...quoteFor(D42161, a5).txRequest!, to: v11.router, approvalAddress: v11.router}};
    expect(check({...p1({sourceToken: CRVUSD, sourceDecimals: 18, destToken: SCRVUSD}), sourceChain: "eip155:42161", destChain: "eip155:42161"}, q5)).toMatch(/swap_type 9 \(ERC-4626\) is not available on Arbitrum's router 1.1.0/);
    const a4 = args("lite4", [[CRVUSD, SCRVUSD, SCRVUSD, [0n, 0n, 9n, 0n]]]);
    const q4 = {...quoteFor(D143, a4), txRequest: {...quoteFor(D143, a4).txRequest!, to: lite.router, approvalAddress: lite.router}};
    expect(check({...p1({sourceToken: CRVUSD, sourceDecimals: 18, destToken: SCRVUSD}), sourceChain: "eip155:143", destChain: "eip155:143"}, q4)).toMatch(/swap_type 9 \(ERC-4626\) is not available on Monad's router 1.1.0/);
  });
  it("a wrap through anything but the pinned wrapped native; zaps, LP and other swap types", () => {
    const fakeWeth = "0x000000000000000000000000000000000000bEEF";
    const wrap = args("ng5", [[CURVE_ETH, fakeWeth, WETH, [0n, 0n, 8n, 0n, 0n]], [WETH, TRICRYPTO_USDT, USDT, [2n, 0n, 1n, 30n, 3n]]]);
    expect(verify(p1({sourceToken: "ETH"}), quoteFor(D1, wrap, {value: AMOUNT.toString(), approval: null}))).toMatch(/wraps through 0x0{36}bEEF, not the pinned wrapped native/i);
    for (const t of [3n, 4n, 6n, 7n]) {
      expect(verify(p1(), quoteFor(D1, args("ng5", [[USDC, TRIPOOL, USDT, [1n, 2n, t, 1n, 3n]]])))).toMatch(new RegExp(`swap_type ${t}, which this module never builds`));
    }
  });
  it("more than two pools, a pool twice, and addresses after the route's end", () => {
    const three = args("ng5", [[USDC, CRVUSD_USDC, CRVUSD, [0n, 1n, 1n, 1n, 2n]], [CRVUSD, CRVUSD_USDC, USDC, [1n, 0n, 1n, 1n, 2n]], [USDC, TRIPOOL, USDT, [1n, 2n, 1n, 1n, 3n]]]);
    expect(verify(p1(), quoteFor(D1, three))).toMatch(/crosses 0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E twice|more than 2/);
    const tail = {route: [...USDC_USDT.route.slice(0, 4), OTHER as Hex, ...USDC_USDT.route.slice(5)], params: USDC_USDT.params};
    expect(verify(p1(), quoteFor(D1, tail))).toMatch(/after its end/);
  });
  it("the router's 0xEeee sentinel named as a token (it must be the catalog's native coin / the zero address)", () => {
    const a = args("ng5", [[CURVE_ETH, STETH_NG, "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", [0n, 1n, 1n, 1n, 2n]]]);
    expect(verify(p1({sourceToken: CURVE_ETH, sourceDecimals: 18, destToken: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84"}), quoteFor(D1, a))).toMatch(/native sentinel is not a token/);
  });
  it("zap pools in the [5][5] _pools argument", () => {
    const R5 = parseAbi(["function exchange(address[11] _route, uint256[5][5] _swap_params, uint256 _amount, uint256 _min_dy, address[5] _pools, address _receiver) payable returns (uint256)"]);
    const data = encodeFunctionData({abi: R5, functionName: "exchange", args: [USDC_USDT.route as never, USDC_USDT.params as never, AMOUNT, MIN, [OTHER, Z, Z, Z, Z], ME]});
    expect(verify(p1(), quoteFor(D1, USDC_USDT, {data}))).toMatch(/zap pools/);
  });
  it("a [4][5] router never routes the native coin into a pool, nor through a legacy pool type", () => {
    const tables = {deployments: DEPLOYMENTS, pools: POOLS};
    const check = curveQuoteCheck(tables);
    const legacy = args("lite4", [[M_USDC, M_OLD_STABLE, M_AUSD, [0n, 1n, 1n, 1n]]]);
    const q = {...quoteFor(D143, legacy)};
    expect(check({sourceChain: "eip155:143", destChain: "eip155:143", sourceToken: "USDC", destToken: M_AUSD, amountIn: AMOUNT.toString(), destAddress: ME}, q)).toMatch(/not in the pool allowlist/);
    const ok = args("lite4", [[M_USDC, M_3POOL, M_AUSD, [1n, 0n, 1n, 10n]]]);
    expect(check({sourceChain: "eip155:143", destChain: "eip155:143", sourceToken: "USDC", destToken: M_AUSD, amountIn: AMOUNT.toString(), destAddress: ME}, quoteFor(D143, ok))).toBeNull();
  });
  it("the provider never routes through a denied pool, whatever its TVL", async () => {
    vi.stubGlobal("fetch", rpcStub());
    let why = "";
    expect(await curveProvider({rpcUrls: RPC, ...TABLES}).getQuote({...p1({destToken: FAKE_USDT}), onRefusal: (r) => { why = r; }})).toBeNull();
    expect(why).toBe("curve: no allowlisted Curve pool route for this pair");
    expect(await curveProvider({rpcUrls: RPC, ...TABLES}).getQuote({...p1({sourceToken: "ETH", destToken: "0x0100546F2cD4C9D97f798fFC9755E47865FF7Ee6"}), onRefusal: (r) => { why = r; }})).toBeNull();
    expect(why).toBe("curve: no allowlisted Curve pool route for this pair");
  });
});

describe("curvePins / curveRemotePins", () => {
  it("pin the router on each chain (call target = spender), and nothing where there is none", () => {
    expect(curvePins.callTargets("eip155:1")).toEqual([CURVE_DEPLOYMENTS[1]!.router]);
    expect(curvePins.spenders("eip155:5000")).toEqual([CURVE_DEPLOYMENTS[5000]!.router]);
    expect(curvePins.callTargets("eip155:999999")).toEqual([]);
    expect(curvePins.spenders("ton:-239")).toEqual([]);
    expect(curvePins.verifyQuote).toBeTypeOf("function");
  });

  it("verifyBuild opens a remote build on chain: router code, pool code and coins, fresh get_dy ≥ minimum", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const pins = curveRemotePins({rpcUrls: RPC, ...TABLES, onWarning: () => {}});
    const q = await curveProvider({rpcUrls: RPC, ...TABLES, onWarning: () => {}}).getQuote(p1({slippageBps: 10}));
    const tx = {chain: "eip155:1", to: q!.txRequest!.to!, data: q!.txRequest!.data!, value: "0", approvalAddress: q!.txRequest!.approvalAddress!};
    expect(await pins.verifyBuild(q!, tx, p1({slippageBps: 10}))).toBeNull();
    expect(await pins.verifyBuild(q!, tx)).toMatch(/request this quote answered is unknown/);
    expect(await pins.verifyBuild(q!, {...tx, data: tx.data.replace(/.{2}$/, "ff")}, p1({slippageBps: 10}))).toMatch(/not the quoted router call/);
    vi.stubGlobal("fetch", rpcStub({badRouterCode: true}));
    const fresh = curveRemotePins({rpcUrls: RPC, ...TABLES, onWarning: () => {}});
    expect(await fresh.verifyBuild(q!, tx, p1({slippageBps: 10}))).toMatch(/code hash mismatch/);
  });

  it("an AddressProvider that names another router changes nothing a build may call or approve", async () => {
    vi.stubGlobal("fetch", rpcStub({addressProvider: OTHER}));
    const pins = curveRemotePins({rpcUrls: RPC, ...TABLES, onWarning: () => {}});
    expect(pins.callTargets("eip155:1")).toEqual([D1.router]);
    const q = quoteFor(D1, USDC_USDT, {to: OTHER, approval: OTHER});
    expect(pins.verifyQuote!(p1(), q)).toMatch(/not the Curve router/);
  });
});

// Every fixture pool the tests above lean on exists in the fixture allowlist.
it("fixture sanity", () => {
  const listed = new Set(POOLS[1]!.pools.map((p) => p.address.toLowerCase()));
  for (const p of [TRIPOOL, CRVUSD_USDC, STETH_NG, TRICRYPTO_USDT, FAKE_USDT_POOL, BROKEN_ALETH]) expect(listed.has(p.toLowerCase())).toBe(true);
  expect(listed.has(UNLISTED_POOL.toLowerCase())).toBe(false);
});

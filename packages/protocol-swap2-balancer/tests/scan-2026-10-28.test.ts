// Scan 2026-10-28, F2: balancerPins pinned only the Vault, so a remote backend redirected batchSwap's output or called
// manageUserBalance on the user's Vault allowances, and the engine sent it. The pins now carry balancerVerifyQuote,
// which opens the Vault call on the client. The attacks are refused before anything is approved; the provider's real
// builds still pass and execute through remoteProvider + pins + engine, behind the real swap2 server handler.
import {afterEach, describe, expect, it, vi} from "vitest";
import {encodeFunctionData, parseAbi, type Hex} from "viem";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {BALANCER_MAX_SWAPS, BALANCER_V2_VAULT, balancerPins, balancerProvider, balancerVerifyQuote} from "../src/provider.js";
import {BAL, ME, POOL_A, POOL_B, RPC, USDC, WETH, ZERO, stub} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());
const noTx = ({txRequest: _tx, ...q}: Quote): Quote => q;

const ATTACKER = "0x9999999999999999999999999999999999999999";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const SWAP_STEP = "(bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)";
const FUNDS = "(address sender, bool fromInternalBalance, address recipient, bool toInternalBalance)";
const ABI = parseAbi([
  `function batchSwap(uint8 kind, ${SWAP_STEP}[] swaps, address[] assets, ${FUNDS} funds, int256[] limits, uint256 deadline) payable returns (int256[] assetDeltas)`,
  `function swap((bytes32 poolId, uint8 kind, address assetIn, address assetOut, uint256 amount, bytes userData) singleSwap, ${FUNDS} funds, uint256 limit, uint256 deadline) payable returns (uint256)`,
  "function manageUserBalance((uint8 kind, address asset, uint256 amount, address sender, address recipient)[] ops) payable",
  "function setRelayerApproval(address sender, address relayer, bool approved)",
]);
const POOL = `0x${"ab".repeat(32)}` as Hex;
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
type Step = {poolId: Hex; assetInIndex: bigint; assetOutIndex: bigint; amount: bigint; userData: Hex};
type Funds = {sender: Hex; fromInternalBalance: boolean; recipient: Hex; toInternalBalance: boolean};
const batch = (o: Partial<{kind: number; swaps: Step[]; assets: Hex[]; funds: Partial<Funds>; limits: bigint[]; deadline: bigint}> = {}) =>
  encodeFunctionData({abi: ABI, functionName: "batchSwap", args: [
    o.kind ?? 0,
    o.swaps ?? [{poolId: POOL, assetInIndex: 0n, assetOutIndex: 1n, amount: 10n ** 18n, userData: "0x"}],
    o.assets ?? [WETH, USDC],
    {sender: ME, fromInternalBalance: false, recipient: ME, toInternalBalance: false, ...o.funds},
    o.limits ?? [10n ** 18n, -1_990_000n],
    o.deadline ?? deadline,
  ]});

/** A backend that answers every quote with the Vault call `txFor` writes (the repro's malicious backend). */
function evilBackend(txFor: (params: QuoteParams) => {data: Hex; value: string; approval: boolean}) {
  return (async (url: string, init: {body: string}) => {
    const action = String(url).split("/").at(-1);
    const body = JSON.parse(init.body) as {params?: QuoteParams; quote?: Quote};
    const reply = (v: unknown) => new Response(JSON.stringify(v), {status: 200, headers: {"content-type": "application/json"}});
    if (action === "quote") {
      const p = body.params!;
      const t = txFor(p);
      return reply({
        provider: "balancer", intentId: `i-${Math.random()}`, depositAddress: "", depositMemo: null,
        sourceAmount: p.amountIn, destAmount: "999999999999999999999", minDestAmount: p.minAmountOut ?? "1",
        feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
        txRequest: {to: BALANCER_V2_VAULT, data: t.data, value: t.value, chainId: 1, gasLimit: "300000", ...(t.approval ? {approvalAddress: BALANCER_V2_VAULT} : {})},
      } satisfies Quote);
    }
    if (action === "build") {
      const tx = body.quote!.txRequest!;
      return reply({...tx, chain: "eip155:1", to: tx.to!, value: tx.value ?? "0"} satisfies UnsignedTx);
    }
    return reply({});
  }) as unknown as typeof fetch;
}

/** The real provider behind the real swap2 handler, as the app's backend runs it. */
function realBackend(): typeof fetch {
  const handle = createSwap2Handler<string>({providers: [balancerProvider({rpcUrls: RPC})], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
  return (async (url: string, init: RequestInit) => {
    const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "alice");
    return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
}

/** The app: remoteProvider({name: "balancer", baseUrl, ...balancerPins}) under the engine, with a recording account. */
function app(fetchImpl: typeof fetch) {
  const sent: Array<{to: string; data?: string; value?: string | bigint}> = [];
  const account = {
    getAddress: async () => ME, getChainId: async () => 1, getAllowance: async () => 0n, waitForTransaction: async () => {},
    sendTransaction: async (tx: {to: string; data?: string; value?: string}) => { sent.push(tx); return {hash: `0x${String(sent.length).padStart(64, "0")}`}; },
  };
  const provider: CrossChainProvider = remoteProvider({name: "balancer", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, supportsSameChain: true, ...balancerPins});
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  return {sent, swap2: new P(account as never, {fromChain: "eip155:1"})};
}

describe("scan 2026-10-28 F2: a remote Balancer Vault call is opened on the client", () => {
  it("the repro's attacks are refused before anything is approved: recipient = attacker, manageUserBalance, native to the attacker", async () => {
    const attacks: Array<[string, (p: QuoteParams) => {data: Hex; value: string; approval: boolean}, string, RegExp]> = [
      ["recipient", (p) => ({data: batch({swaps: [{poolId: POOL, assetInIndex: 0n, assetOutIndex: 1n, amount: BigInt(p.amountIn), userData: "0x"}], assets: [USDC, WETH], funds: {recipient: ATTACKER}, limits: [BigInt(p.amountIn), 0n]}), value: "0", approval: true}), "USDC", /pays 0x9999/],
      ["manageUserBalance", (p) => ({data: encodeFunctionData({abi: ABI, functionName: "manageUserBalance", args: [[
        {kind: 3, asset: USDC, amount: BigInt(p.amountIn), sender: ME, recipient: ATTACKER},
        {kind: 3, asset: DAI, amount: 10n ** 24n, sender: ME, recipient: ATTACKER},
      ]]}), value: "0", approval: true}), "USDC", /not batchSwap/],
      ["native", (p) => ({data: batch({swaps: [{poolId: POOL, assetInIndex: 0n, assetOutIndex: 1n, amount: BigInt(p.amountIn), userData: "0x"}], assets: [ZERO, USDC], funds: {recipient: ATTACKER}, limits: [BigInt(p.amountIn), 0n]}), value: p.amountIn, approval: false}), "ETH", /pays 0x9999/],
    ];
    for (const [what, txFor, fromToken, why] of attacks) {
      const {sent, swap2} = app(evilBackend(txFor));
      const toToken = fromToken === "ETH" ? USDC : WETH;
      const outcome = await swap2.swap2({fromToken, toToken, toChain: 1, recipient: ME, fromTokenAmount: fromToken === "ETH" ? 10n ** 16n : 1_000_000n, minAmountOut: 1n} as never).then(() => "RESOLVED", (e: Error) => e.message);
      expect(outcome, what).toMatch(/fails this app's own check/);
      expect(outcome, what).toMatch(why);
      expect(sent, what).toEqual([]);
    }
  });

  it("balancerVerifyQuote refuses every other shape: other Vault calls, kind, internal balance, limits, assets, hops, userData", async () => {
    vi.stubGlobal("fetch", stub({vaultOut: 2_000_000n}));
    const params: QuoteParams = {sourceChain: "eip155:1", destChain: "eip155:1", sourceToken: "WETH", destToken: USDC, amountIn: "1000000000000000000", destAddress: ME, refundAddress: ME};
    const real = (await balancerProvider({rpcUrls: RPC}).getQuote(params))!;
    expect(balancerVerifyQuote(params, real)).toBeNull();
    const withData = (data: Hex): Quote => ({...real, txRequest: {...real.txRequest!, data}});
    const step = (o: Partial<Step> = {}): Step => ({poolId: POOL, assetInIndex: 0n, assetOutIndex: 1n, amount: 10n ** 18n, userData: "0x", ...o});
    const cases: Array<[string, Quote, RegExp]> = [
      ["no Vault call (a deposit address)", {...noTx(real), depositAddress: ATTACKER}, /no Vault call/],
      ["another target", {...real, txRequest: {...real.txRequest!, to: ATTACKER}}, /not the Vault/],
      ["approval to another spender", {...real, txRequest: {...real.txRequest!, approvalAddress: ATTACKER}}, /approves the Vault/],
      ["swap()", withData(encodeFunctionData({abi: ABI, functionName: "swap", args: [{poolId: POOL, kind: 0, assetIn: WETH, assetOut: USDC, amount: 10n ** 18n, userData: "0x"}, {sender: ME, fromInternalBalance: false, recipient: ATTACKER, toInternalBalance: false}, 0n, deadline]})), /is not batchSwap/],
      ["setRelayerApproval", withData(encodeFunctionData({abi: ABI, functionName: "setRelayerApproval", args: [ME, ATTACKER, true]})), /is not batchSwap/],
      ["GIVEN_OUT", withData(batch({kind: 1})), /not GIVEN_IN/],
      ["internal balance in", withData(batch({funds: {fromInternalBalance: true}})), /internal balances/],
      ["internal balance out", withData(batch({funds: {toInternalBalance: true}})), /internal balances/],
      ["foreign sender", withData(batch({funds: {sender: ATTACKER}})), /takes from 0x9999/],
      ["no output limit", withData(batch({limits: [10n ** 18n, 0n]})), /limits are not exactly/],
      ["a larger input limit", withData(batch({limits: [2n * 10n ** 18n, -1_990_000n]})), /limits are not exactly/],
      ["another asset", withData(batch({assets: [WETH, DAI]})), /requested tokens/],
      ["a duplicated asset", withData(batch({assets: [WETH, USDC, WETH], limits: [10n ** 18n, -1_990_000n, 0n]})), /names an asset twice/],
      ["a hop selling another asset", withData(batch({assets: [WETH, USDC, DAI], limits: [10n ** 18n, -1_990_000n, 0n], swaps: [step(), step({assetInIndex: 2n, amount: 5n})]})), /another asset than the input/],
      ["hops selling less than the input", withData(batch({swaps: [step({amount: 1n})]})), /sell 1, not/],
      ["no hop to the output", withData(batch({assets: [WETH, USDC, DAI], limits: [10n ** 18n, -1_990_000n, 0n], swaps: [step({assetOutIndex: 2n})]})), /no hop delivers/],
      ["pool userData", withData(batch({swaps: [step({userData: "0x01"})]})), /userData/],
      ["too many hops", withData(batch({swaps: [step(), ...Array.from({length: BALANCER_MAX_SWAPS}, () => step({amount: 0n, assetInIndex: 1n, assetOutIndex: 0n}))]})), /pool hops, not 1–16/],
      ["an expired deadline", withData(batch({deadline: 1n})), /deadline/],
    ];
    for (const [what, q, why] of cases) expect(balancerVerifyQuote(params, q), what).toMatch(why);
  });

  it("the provider's real builds pass the verifier: token in, native in, native out, multi-hop splits", async () => {
    const base = {sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, refundAddress: ME};
    const runs: Array<[QuoteParams, Parameters<typeof stub>[0]]> = [
      [{...base, sourceToken: "WETH", destToken: USDC, amountIn: "1000000000000000000"}, {vaultOut: 2_000_000n}],
      [{...base, sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000000"}, {}],
      [{...base, sourceToken: "USDC", destToken: ZERO, amountIn: "1000000"}, {paths: [{pools: [POOL_A], tokens: [USDC, WETH], amountIn: "1000000"}], vaultOut: 4n * 10n ** 14n}],
      [{...base, sourceToken: "WETH", destToken: USDC, amountIn: "1000000000000000000"}, {paths: [{pools: [POOL_A, POOL_B], tokens: [WETH, BAL, USDC], amountIn: "600000000000000000"}, {pools: [POOL_B], tokens: [WETH, USDC], amountIn: "400000000000000000"}]}],
    ];
    for (const [params, o] of runs) {
      vi.stubGlobal("fetch", stub(o));
      const q = await balancerProvider({rpcUrls: RPC}).getQuote(params);
      expect(q, JSON.stringify(params)).not.toBeNull();
      expect(balancerVerifyQuote(params, q!), JSON.stringify(params)).toBeNull();
    }
  });

  it("corridor: real builds execute through remoteProvider + balancerPins + the engine (token in, native in, native out)", async () => {
    const runs: Array<[string, string, bigint, Parameters<typeof stub>[0], string[]]> = [
      ["WETH", USDC, 10n ** 18n, {vaultOut: 2_000_000n}, [WETH, BALANCER_V2_VAULT]],
      ["ETH", USDC, 10n ** 18n, {}, [BALANCER_V2_VAULT]],
      ["USDC", ZERO, 1_000_000n, {paths: [{pools: [POOL_A], tokens: [USDC, WETH], amountIn: "1000000"}], vaultOut: 4n * 10n ** 14n}, [USDC, BALANCER_V2_VAULT]],
    ];
    for (const [fromToken, toToken, amount, o, targets] of runs) {
      vi.stubGlobal("fetch", stub(o));
      const {sent, swap2} = app(realBackend());
      const result = await swap2.swap2({fromToken, toToken, toChain: 1, recipient: ME, fromTokenAmount: amount, minAmountOut: 1n} as never);
      expect(result, `${fromToken} → ${toToken}`).toMatchObject({id: expect.any(String)});
      expect(sent.map((t) => t.to.toLowerCase())).toEqual(targets.map((t) => t.toLowerCase()));
    }
  });
});

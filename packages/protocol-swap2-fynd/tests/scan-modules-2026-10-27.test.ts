// Scan 2026-10-27 (modules), F9: behind `remoteProvider` the Fynd router pin and checkFyndTransaction ran only on the
// server, and the client trusted the addresses the server sent. With `fyndPins` the app checks a remote quote against
// FYND_CHAINS and re-runs checkFyndTransaction against its own request. A fake backend, no network, no keys.
import {afterEach, describe, expect, it, vi} from "vitest";
import {encodeFunctionData} from "viem";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {fyndProvider} from "../src/provider.js";
import {FYND_CHAINS, ROUTER_NATIVE, TYCHO_ROUTER_ABI, checkFyndTransaction, fyndPins, fyndVerifyQuote} from "../src/router.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const USER = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x9999999999999999999999999999999999999999";
const ROUTER = FYND_CHAINS[8453]!.router;
const NO_FEE = {clientFeeBps: 0, clientFeeReceiver: ZERO, maxClientContribution: 0n, deadline: 0n, clientSignature: "0x"} as const;
const GROSS = 250_000_000_000_000n, MIN = 248_750_000_000_000n;
const single = (receiver = USER) => encodeFunctionData({abi: TYCHO_ROUTER_ABI, functionName: "singleSwap", args: [1_000_000n, USDC, WETH, GROSS, MIN, receiver as `0x${string}`, NO_FEE as never, "0xdeadbeef"]});

const quoteFor = (params: QuoteParams, tx: {to: string; data: string}): Quote => ({
  provider: "fynd", intentId: "fynd:8453", depositAddress: "", depositMemo: null,
  txRequest: {to: tx.to, data: tx.data, value: "0", chainId: 8453, gasLimit: "300000", approvalAddress: tx.to},
  sourceAmount: params.amountIn, destAmount: (GROSS - 1000n).toString(), minDestAmount: MIN.toString(), feeUsd: 0, etaSeconds: 15, reliability: 0.96,
  validUntilMs: Date.now() + 30_000, providerData: {gross: GROSS.toString(), routerFee: "1000", minOut: MIN.toString(), sender: USER},
} as Quote);

/** A remote Fynd stub whose backend answers with `tx`, wired the way the README says: `...fyndPins`. */
function stub(tx: {to: string; data: string}, pins = true): CrossChainProvider {
  const fetchImpl = (async (url: string, init: {body: string}) => {
    const action = String(url).split("/").at(-1);
    const body = JSON.parse(init.body) as {params?: QuoteParams; quote?: Quote};
    const reply = (v: unknown) => new Response(JSON.stringify(v), {status: 200, headers: {"content-type": "application/json"}});
    if (action === "quote") return reply(quoteFor(body.params!, tx));
    if (action === "build") { const {nativeFee: _fee, ...t} = body.quote!.txRequest!; const tx: UnsignedTx = {...t, chain: "eip155:8453", to: t.to!, value: t.value ?? "0"}; return reply(tx); }
    return reply({});
  }) as unknown as typeof fetch;
  return remoteProvider({name: "fynd", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, supportsSameChain: true, ...(pins ? fyndPins : {})});
}
function engine(provider: CrossChainProvider) {
  const sent: unknown[] = [];
  const account = {getAddress: async () => USER, getChainId: async () => 8453, getAllowance: async () => 0n, waitForTransaction: async () => {}, sendTransaction: async (t: unknown) => { sent.push(t); return {hash: `0x${sent.length}`}; }};
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  return {sent, p: new P(account as never, {fromChain: "eip155:8453"} as never)};
}
const options = {fromToken: "USDC", toToken: WETH, toChain: 8453, recipient: USER, fromTokenAmount: 1_000_000n, minAmountOut: MIN};

describe("Fynd behind remoteProvider (scan 2026-10-27 modules, F9)", () => {
  it("a remote quote whose router is not the one in FYND_CHAINS is refused; nothing is approved", async () => {
    const {sent, p} = engine(stub({to: ATTACKER, data: single()}));
    await expect(p.swap2(options)).rejects.toThrow(/did not pin as a spender|not the Tycho router/);
    expect(sent).toHaveLength(0);
  });

  it("the pinned router with calldata paying someone else is refused by checkFyndTransaction on the client", async () => {
    const {sent, p} = engine(stub({to: ROUTER, data: single(ATTACKER)}));
    await expect(p.swap2(options)).rejects.toThrow(/fails this app's own check — calldata pays 0x9999/);
    expect(sent).toHaveLength(0);
  });

  it("an honest remote quote passes and executes: approve the pinned router for the input, then the swap", async () => {
    const {sent, p} = engine(stub({to: ROUTER, data: single()}));
    await p.swap2(options);
    expect((sent as Array<{to: string}>).map((t) => t.to.toLowerCase())).toEqual([USDC.toLowerCase(), ROUTER.toLowerCase()]);
  });

  it("without the pins, the remote stub gets no route at all (fail closed)", async () => {
    const {sent, p} = engine(stub({to: ROUTER, data: single()}, false));
    await expect(p.swap2(options)).rejects.toThrow(/did not pin/);
    expect(sent).toHaveLength(0);
  });

  it("fyndPins pin the router per chain and nothing elsewhere; fyndVerifyQuote names what is wrong", () => {
    expect(fyndPins.callTargets("eip155:8453")).toEqual([ROUTER]);
    expect(fyndPins.spenders("eip155:1")).toEqual([FYND_CHAINS[1]!.router]);
    expect(fyndPins.callTargets("eip155:10")).toEqual([]);
    expect(fyndPins.callTargets("solana:mainnet")).toEqual([]);
    const params = {sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:8453", destToken: WETH, amountIn: "1000000", destAddress: USER, dry: false} as QuoteParams;
    expect(fyndVerifyQuote(params, quoteFor(params, {to: ROUTER, data: single()}))).toBeNull();
    expect(fyndVerifyQuote({...params, amountIn: "2000000"}, quoteFor(params, {to: ROUTER, data: single()}))).toMatch(/spends 1000000, not 2000000/);
  });
});

// Scan 2026-10-27 (modules), F24/F34: preflightDeposit ran `eth_call` with the `tx` it was handed — behind a backend
// the client's, so the operator's RPC simulated any call to any target. And refusals put API fields (the transaction
// target, protocol names) into messages unbounded. Now only the quote's own transaction is simulated, `tx.to` is named
// only when it is an address, and protocol names are cut to 40 characters.
describe("Fynd preflight and refusals are bounded (scan 2026-10-27 modules, F24/F34)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const RPC = {8453: ["https://rpc.test"]};

  /** The hosted API (one order: `protocols`, native or ERC-20 in) and an RPC whose eth_call reverts when `revert`. */
  function api(o: {protocols?: string[]; revert?: boolean} = {}) {
    const ethCalls: Array<{to: string; data: string; value: string}> = [];
    vi.stubGlobal("fetch", (async (url: string, init: {body: string}) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (url.includes("/quote")) {
        const order = (body.orders as Record<string, string>[])[0]!;
        const amountIn = BigInt(order.amount!);
        const slip = ((GROSS * 50n) / 10_000n);
        const min = GROSS - slip;
        const sentinel = (t: string) => (t === ZERO ? ROUTER_NATIVE : t);
        const data = encodeFunctionData({abi: TYCHO_ROUTER_ABI, functionName: "singleSwap", args: [amountIn, sentinel(order.token_in!) as `0x${string}`, sentinel(order.token_out!) as `0x${string}`, GROSS, min, order.receiver as `0x${string}`, NO_FEE as never, "0xdeadbeef"]});
        return new Response(JSON.stringify({orders: [{status: "success", amount_in: amountIn.toString(), amount_out: GROSS.toString(), gas_estimate: "150000",
          route: {swaps: (o.protocols ?? ["uniswap_v3"]).map((protocol) => ({protocol}))},
          fee_breakdown: {router_fee: "0", client_fee: "0", max_slippage: slip.toString(), min_amount_received: min.toString()},
          transaction: {to: ROUTER, value: order.token_in === ZERO ? amountIn.toString() : "0", data}}]}));
      }
      const rpc = body as {method: string; params: Array<{to: string; data: string; value: string}>};
      if (rpc.method === "eth_call") {
        ethCalls.push(rpc.params[0]!);
        return new Response(JSON.stringify(o.revert ? {jsonrpc: "2.0", id: 1, error: {message: "execution reverted"}} : {jsonrpc: "2.0", id: 1, result: "0x"}));
      }
      return new Response("{}", {status: 404});
    }) as unknown as typeof fetch);
    return ethCalls;
  }

  it("a tx that is not the quote's (another target, a megabyte of calldata, another value) is refused before any eth_call", async () => {
    const ethCalls = api();
    const p = fyndProvider({apiKey: "k", rpcUrls: RPC});
    const quote = {...quoteFor(options as never, {to: ROUTER, data: single()}), sourceAmount: "1000000"};
    const honest: UnsignedTx = {chain: "eip155:8453", to: ROUTER, value: "0", data: single()};
    for (const tx of [{...honest, to: ATTACKER}, {...honest, data: `0x${"00".repeat(500_000)}`}, {...honest, data: single(ATTACKER)}, {...honest, value: "1"}, {...honest, value: "not a number"}]) {
      await expect(p.preflightDeposit!(quote, tx)).rejects.toThrow("fynd: the transaction is not the quoted swap. Nothing was sent; refresh the quote.");
    }
    expect(ethCalls).toEqual([]);
    await p.preflightDeposit!(quote, {...honest, to: ROUTER.toLowerCase()});
    expect(ethCalls).toEqual([{from: USER, to: ROUTER, data: single(), value: "0x0"}]);
  });

  it("checkFyndTransaction names the target only when it is an address", () => {
    const expected = {chainId: 8453, tokenIn: USDC, tokenOut: WETH, amountIn: 1_000_000n, receiver: USER, expectedAmountOut: GROSS, minAmountOut: MIN};
    expect(() => checkFyndTransaction({to: ATTACKER, value: 0n, data: single()}, expected)).toThrow(`the transaction targets ${ATTACKER}, not the Tycho router on`);
    for (const to of ["x".repeat(1_000_000), `${ATTACKER} — call support at https://evil.example`]) {
      let message = "";
      try { checkFyndTransaction({to, value: 0n, data: single()}, expected); } catch (e) { message = (e as Error).message; }
      expect(message).toMatch(/^fynd: the transaction targets something that is not an address, not the Tycho router on Base$/);
    }
  });

  it("protocol names from the API are cut to 40 characters in refusals and in the quote", async () => {
    const long = `vm:${"a".repeat(100_000)}`;
    api({protocols: [long]});
    let why = "";
    await fyndProvider({apiKey: "k", rpcUrls: RPC, excludeProtocols: ["vm:"]}).getQuote({...PARAMS, onRefusal: (r) => { why = r; }});
    expect(why).toBe(`fynd: the route goes through ${long.slice(0, 40)}…, which this wallet excludes`);
    api({protocols: Array.from({length: 50}, (_, i) => `p${i}${"b".repeat(100_000)}`), revert: true});
    await fyndProvider({apiKey: "k", rpcUrls: RPC}).getQuote({...PARAMS, sourceToken: "ETH", onRefusal: (r) => { why = r; }});
    expect(why.startsWith("fynd: the route does not execute on-chain right now (simulation reverted via p0")).toBe(true);
    expect(why.length).toBeLessThan(400);
    api({protocols: [long]});
    const q = await fyndProvider({apiKey: "k", rpcUrls: RPC}).getQuote(PARAMS);
    expect(q!.providerData!.protocols).toBe(`${long.slice(0, 40)}…`);
  });
});
const PARAMS = {sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:8453", destToken: WETH, amountIn: "1000000", destAddress: USER, refundAddress: USER, slippageBps: 50, dry: false};

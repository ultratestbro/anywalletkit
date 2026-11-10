// What the device checks before anything is signed, on real recorded routes with one thing rewritten
// at a time (tests/fixtures.ts re-encodes every nesting level canonically around the edit, with its own
// copy of the ABIs — the tests do not share a decoder with the code under test).
import {beforeAll, describe, expect, it} from "vitest";
import {Address, beginCell, Cell} from "@ton/core";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {SYMBIOSIS_AGGREGATORS, SYMBIOSIS_CHAINS, SYMBIOSIS_REVERTER, SYMBIOSIS_UNWRAPPERS} from "../src/config.js";
import {SYMBIOSIS_TON_VALUE_CEILING, symbiosisInspectQuote, symbiosisVerifyBuild, symbiosisVerifyQuote} from "../src/verify.js";
import {ABI, EVIL, EVM, KYBER_ABI, ONE_INCH_ABI, close, dec, enc, lastOnly, open, quoteOf, rewrite, type Parts} from "./fixtures.js";

const OPTIONS = {fallbackReceiver: EVM};
const SERVED = ["eth-usdc-arb-usdc", "bsc-usdc-ton-usdt", "bsc-usdt-ton-usdt", "tron-usdt-base-usdc", "tron-usdt-ton-usdt", "eth-eth-base-eth", "bsc-bnb-eth-eth", "ton-usdt-tron-usdt", "ton-usdt-base-usdc"] as const;
type Name = (typeof SERVED)[number];

const real = {} as Record<Name, {quote: Quote; params: QuoteParams}>;
beforeAll(async () => {
  for (const name of SERVED) {
    const {quote, refusal, recorded} = await quoteOf(name, {exchanges: lastOnly});
    if (!quote) throw new Error(`${name}: ${refusal}`);
    real[name] = {quote, params: recorded.params};
  }
});

const verify = (name: Name, quote: Quote, params: Partial<QuoteParams> = {}) => symbiosisVerifyQuote({...real[name].params, ...params}, quote, OPTIONS);
const edited = (name: Name, edit: (p: Parts) => void) => verify(name, rewrite(real[name].quote, edit));
const withTx = (name: Name, tx: Partial<NonNullable<Quote["txRequest"]>>): Quote => ({...real[name].quote, txRequest: {...real[name].quote.txRequest!, ...tx}});
const bound = (name: Name, quote: Quote) => symbiosisInspectQuote(real[name].params, quote, OPTIONS);

describe("real routes pass, and say what they rest on", () => {
  it("every recorded route is accepted as recorded and as re-encoded by the test's own ABI", () => {
    for (const name of SERVED) {
      expect(verify(name, real[name].quote), name).toBeNull();
      if (real[name].quote.txRequest) expect(close(open(real[name].quote.txRequest!.data!)).toLowerCase(), name).toBe(real[name].quote.txRequest!.data!.toLowerCase());
    }
  });
  it("names the allow-listed contract a route swaps on, and who may revert it", () => {
    expect(bound("eth-usdc-arb-usdc", real["eth-usdc-arb-usdc"].quote)).toEqual({bound: {sourceSwap: null, destSwap: null, serviceReverts: true}});
    expect(bound("bsc-usdt-ton-usdt", real["bsc-usdt-ton-usdt"].quote)).toEqual({bound: {sourceSwap: "uniswap-v2", destSwap: null, serviceReverts: true}});
    expect(bound("tron-usdt-base-usdc", real["tron-usdt-base-usdc"].quote)).toEqual({bound: {sourceSwap: null, destSwap: "uniswap-v2", serviceReverts: true}});
    expect(bound("eth-eth-base-eth", real["eth-eth-base-eth"].quote)).toEqual({bound: {sourceSwap: null, destSwap: "unwrap", serviceReverts: true}});
    expect(bound("bsc-bnb-eth-eth", real["bsc-bnb-eth-eth"].quote)).toEqual({bound: {sourceSwap: "uniswap-v2", destSwap: "unwrap", serviceReverts: true}});
    expect(bound("ton-usdt-base-usdc", real["ton-usdt-base-usdc"].quote)).toEqual({bound: {sourceSwap: null, destSwap: "uniswap-v2", serviceReverts: true}});
  });
  it("the revert address the API writes is Symbiosis' reverter on the bridge request — that is what serviceReverts reports", () => {
    expect(open(real["eth-usdc-arb-usdc"].quote.txRequest!.data!).s.revertableAddress).toBe(SYMBIOSIS_REVERTER);
    // With the user's own address there, nothing rests on the service.
    const own = rewrite(real["eth-usdc-arb-usdc"].quote, (p) => { p.s.revertableAddress = EVM; });
    expect(bound("eth-usdc-arb-usdc", own)).toEqual({bound: {sourceSwap: null, destSwap: null, serviceReverts: false}});
  });
});

describe("the request: a quote for another recipient, token, chain or amount is refused", () => {
  const n = "eth-usdc-arb-usdc";
  it("recipient", () => expect(verify(n, real[n].quote, {destAddress: EVIL})).toMatch(/not the recipient|not one of the user's addresses/));
  it("token", () => expect(verify(n, real[n].quote, {destToken: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"})).toMatch(/releases another token than the one quoted/));
  it("chain", () => expect(verify(n, real[n].quote, {destChain: "eip155:8453", destToken: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"})).toMatch(/not a pinned synthetic of a Base token/));
  it("source chain", () => expect(verify(n, real[n].quote, {sourceChain: "eip155:56"})).toMatch(/for chain 1, not BNB Chain/));
  it("amount", () => expect(verify(n, real[n].quote, {amountIn: "100000001"})).toMatch(/different amount/));
  it("sender", () => expect(verify(n, real[n].quote, {refundAddress: EVIL})).toMatch(/on behalf of .* not the sender/));
  it("a minimum above what the route itself guarantees", () => {
    const more = (BigInt(real[n].quote.minDestAmount!) + 1n).toString();
    expect(verify(n, {...real[n].quote, minDestAmount: more})).toMatch(/guarantees 99197101, below the quoted minimum 99197102/);
    expect(verify(n, {...real[n].quote, minDestAmount: "0"})).toMatch(/names no minimum/);
  });
  it("a deposit address or a serialized transaction on a contract-call route", () => {
    expect(verify(n, {...real[n].quote, depositAddress: EVIL})).toMatch(/carries no transaction/);
    expect(verify(n, withTx(n, {serializedTx: "00"}))).toMatch(/serialized/);
  });
});

describe("EVM source: target, value, spender, chain", () => {
  const n = "eth-usdc-arb-usdc";
  it("to", () => expect(verify(n, withTx(n, {to: EVIL}))).toMatch(/calls 0x0{36}dEaD, not the pinned Ethereum MetaRouterGateway/));
  it("the executor MetaRouter itself is not an accepted target (a user never approves or calls it)", () => {
    expect(verify(n, withTx(n, {to: SYMBIOSIS_CHAINS["eip155:1"]!.executor!}))).toMatch(/not the pinned Ethereum MetaRouterGateway/);
  });
  it("value", () => expect(verify(n, withTx(n, {value: "1"}))).toMatch(/attaches 1, expected 0/));
  it("spender", () => {
    expect(verify(n, withTx(n, {approvalAddress: EVIL}))).toMatch(/approval names .* not the pinned Ethereum MetaRouterGateway/);
    expect(verify(n, withTx(n, {approvalAddress: SYMBIOSIS_CHAINS["eip155:1"]!.executor!}))).toMatch(/approval names/);
    const {approvalAddress: _, ...noApproval} = real[n].quote.txRequest!;
    expect(verify(n, {...real[n].quote, txRequest: noApproval})).toMatch(/approval names undefined/);
  });
  it("chain id", () => expect(verify(n, withTx(n, {chainId: 56}))).toMatch(/for chain 56, not Ethereum/));
  it("a native sale never asks for an approval and attaches exactly the amount", () => {
    const e = "eth-eth-base-eth";
    expect(verify(e, withTx(e, {approvalAddress: real[e].quote.txRequest!.to!}))).toMatch(/native sale asks for an approval/);
    expect(verify(e, withTx(e, {value: "50000000000000001"}))).toMatch(/attaches 50000000000000001, expected 50000000000000000/);
    expect(verify(e, withTx(e, {value: "0"}))).toMatch(/attaches 0/);
  });
  it("another function, garbage, or bytes after the canonical encoding", () => {
    expect(verify(n, withTx(n, {data: "0x095ea7b3" + "00".repeat(64)}))).toMatch(/unexpected function 0x095ea7b3/);
    expect(verify(n, withTx(n, {data: "0xa11b1198" + "ff".repeat(40)}))).toMatch(/does not decode/);
    expect(verify(n, withTx(n, {data: real[n].quote.txRequest!.data! + "00".repeat(32)}))).toMatch(/not canonically encoded/);
    expect(verify(n, withTx(n, {data: "nope"}))).toMatch(/not hex calldata/);
  });
});

describe("metaRoute and the bridge request", () => {
  const n = "eth-usdc-arb-usdc";
  const cases: [string, (p: Parts) => void, RegExp][] = [
    ["amount", (p) => { p.t.amount += 1n; }, /sells 100000001, not 100000000/],
    ["sell token", (p) => { p.t.approvedTokens = [EVIL, p.t.approvedTokens[1]]; }, /sells token .* not the requested one/],
    ["native flag", (p) => { p.t.nativeIn = true; }, /native flag/],
    ["three approved tokens", (p) => { p.t.approvedTokens = [...p.t.approvedTokens, EVIL]; }, /unexpected token list/],
    ["second source-chain swap", (p) => { p.t.secondSwapCalldata = "0x00"; }, /second source-chain swap/],
    ["relay recipient", (p) => { p.t.relayRecipient = EVIL; }, /hands the funds to .* not the pinned Ethereum Portal/],
    ["a swap target without a call", (p) => { p.t.firstDexRouter = EVIL; }, /source swap target without a call/],
    ["bridged token is not the approved one", (p) => { p.s.rtoken = EVIL; }, /bridged token is not the last approved token/],
    ["bridged token is not the sell token, with no swap", (p) => { p.t.approvedTokens = [p.t.approvedTokens[0], EVIL]; p.s.rtoken = EVIL; }, /no source swap, yet the bridged token is not the sell token/],
    ["bridge amount", (p) => { p.s.amount -= 1n; p.mc[0] -= 1n; }, /bridge request moves 99999999, not 100000000/],
    ["caller", (p) => { p.s.syntCaller = EVIL; }, /on behalf of .* not the sender/],
    ["host-chain credit", (p) => { p.s.chain2address = EVIL; }, /credits .* not one of the user's addresses/],
    ["revert address", (p) => { p.s.revertableAddress = EVIL; }, /lets .* revert it — neither the user nor Symbiosis' revert service/],
    ["host chain id", (p) => { p.s.chainID = 1n; }, /targets chain 1, not Symbiosis' host chain/],
    ["host Synthesis", (p) => { p.s.receiveSide = EVIL; }, /pinned host-chain Synthesis/],
    ["final receive side", (p) => { p.s.finalReceiveSide = EVIL; }, /pinned host-chain Synthesis/],
    ["host Bridge", (p) => { p.s.oppositeBridge = EVIL; }, /pinned host-chain Bridge/],
    ["fee takes everything", (p) => { p.s.stableBridgingFee = p.s.amount; }, /fee takes the whole amount/],
    ["minted synthetic is another chain's", (p) => { p.s.swapTokens = ["0x076Cb7BEee7D1507DE7B964c29cbC849acaD5022", p.s.swapTokens[1]]; }, /does not start from the pinned synthetic of the bridged token/],
    ["final amount offset", (p) => { p.s.finalOffset = 68n; }, /unexpected amount offset 68 in the final call/],
  ];
  for (const [name, edit, why] of cases) it(name, () => expect(edited(n, edit)).toMatch(why));

  it("no pool swap (encoded without one)", () => {
    const p = open(real[n].quote.txRequest!.data!);
    const s = {...p.s, secondSwapCalldata: "0x"};
    const data = enc("metaRoute", [{...p.t, otherSideCalldata: enc("metaSynthesize", [s])}]);
    expect(verify(n, withTx(n, {data}))).toMatch(/carries no host-chain pool swap/);
  });
});

describe("point 1 — the host-chain multicall: pinned pools, the pool swap only, pinned offsets and receivers", () => {
  const n = "eth-usdc-arb-usdc";
  const cases: [string, (p: Parts) => void, RegExp][] = [
    ["the multicall target is not the pinned MulticallRouter", (p) => { p.s.secondDexRouter = EVIL; }, /calls .* not the pinned MulticallRouter/],
    ["a step calls a contract that is not a pinned pool", (p) => { p.mc[2] = [EVIL]; }, /step 1 calls .* not a pinned Symbiosis pool/],
    ["a step calls a pinned token instead of a pool (an approve target)", (p) => { p.mc[2] = [p.mc[3][0]]; }, /not a pinned Symbiosis pool/],
    ["the running amount is written elsewhere", (p) => { p.mc[4] = [68n]; }, /writes the running amount at 68, not into the swap amount/],
    ["the output goes to another address", (p) => { p.mc[5] = EVIL; }, /pays .* not the pinned host-chain MetaRouter/],
    ["the pool pays another address", (p) => { p.pools[0]![4] = EVIL; }, /step 1 pays .* not the MulticallRouter/],
    ["a token index the pool does not have", (p) => { p.pools[0]![1] = 99n; }, /names a token index the pool does not have/],
    ["an inactive index", (p) => { p.pools[0]![1] = 1n; }, /does not trade the path's tokens/],
    ["another token of the same pool", (p) => { p.pools[0]![1] = 15n; }, /does not trade the path's tokens/],
    ["the same index twice", (p) => { p.pools[0]![1] = p.pools[0]![0]; }, /token index/],
    ["no minimum", (p) => { p.pools[0]![3] = 0n; }, /names no minimum/],
    ["a minimum below the quote's", (p) => { p.pools[0]![3] = 1_000_000n; }, /guarantees 750000, below the quoted minimum 99197101/],
    ["sized for another amount", (p) => { p.mc[0] += 1n; }, /sized for another amount than the bridge request/],
    ["the path is not the request's token pair", (p) => { p.mc[3] = [p.mc[3][0], EVIL]; }, /path is not the bridge request's token pair/],
    ["path and steps disagree in length", (p) => { p.mc[3] = [...p.mc[3], EVIL]; }, /malformed step list/],
    ["offsets and steps disagree in length", (p) => { p.mc[4] = [100n, 100n]; }, /malformed step list/],
    ["no steps", (p) => { p.pools.length = 0; p.mc[2] = []; p.mc[4] = []; p.mc[3] = [p.mc[3][0]]; }, /malformed step list/],
  ];
  for (const [name, edit, why] of cases) it(name, () => expect(edited(n, edit)).toMatch(why));

  it("a step that is not the pool swap function (an approve to a pinned pool address)", () => {
    const p = open(real[n].quote.txRequest!.data!);
    const mc = [...p.mc];
    mc[1] = [enc("transfer", [EVIL, 1n])];
    const s = {...p.s, secondSwapCalldata: enc("multicall", mc)};
    const data = enc("metaRoute", [{...p.t, otherSideCalldata: enc("metaSynthesize", [s])}]);
    expect(verify(n, withTx(n, {data}))).toMatch(/host-chain swap step 1: unexpected function 0xa9059cbb/);
  });
  it("the host-chain call is another function of the MulticallRouter", () => {
    const p = open(real[n].quote.txRequest!.data!);
    const s = {...p.s, secondSwapCalldata: enc("transfer", [EVIL, 1n])};
    const data = enc("metaRoute", [{...p.t, otherSideCalldata: enc("metaSynthesize", [s])}]);
    expect(verify(n, withTx(n, {data}))).toMatch(/multicall: unexpected function/);
  });
  it("the stated amount is far below the minimum the pool swap demands", () => {
    // A direct route cannot shrink the amount (it is the sell amount); a route with a source swap could.
    const b = "bsc-usdt-ton-usdt";
    expect(edited(b, (p) => { p.s.amount /= 2n; p.mc[0] = p.s.amount; })).toMatch(/far below/);
  });
});

describe("point 3 — the burned token is the pinned synthetic of the quoted token on the destination", () => {
  const n = "eth-usdc-arb-usdc";
  it("the burn names another synthetic than the pools pay out", () => {
    expect(edited(n, (p) => { p.burn.sToken = "0xfbe80e8c3fbff0bc314b33d1c6185230ac319309"; })).toMatch(/burn names another token than the one the pools pay out/);
  });
  it("the whole route consistently ends in another chain's synthetic (Base USDbC for an Arbitrum request)", () => {
    const usdbc = "0xfbe80e8c3fbff0bc314b33d1c6185230ac319309";
    expect(edited(n, (p) => { p.s.swapTokens = [p.s.swapTokens[0], usdbc]; p.mc[3] = [p.mc[3][0], usdbc]; p.pools[0]![1] = 15n; p.burn.sToken = usdbc; }))
      .toMatch(/burns 0xfbe80e8c3fbff0bc314b33d1c6185230ac319309, which is not a pinned synthetic of a Arbitrum token/i);
  });
  it("an unknown token as the burned one", () => {
    expect(edited(n, (p) => { p.s.swapTokens = [p.s.swapTokens[0], EVIL]; p.mc[3] = [p.mc[3][0], EVIL]; p.burn.sToken = EVIL; })).toMatch(/does not trade the path's tokens|not a pinned synthetic/);
  });
  it("the right chain's synthetic of another token than the one quoted", () => {
    // Arbitrum WETH's synthetic sits in another pool; the request asks for USDC.
    expect(verify(n, real[n].quote, {destToken: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1"})).toMatch(/releases another token than the one quoted/);
  });
});

describe("the burn (EVM / Tron destination)", () => {
  const n = "eth-usdc-arb-usdc";
  const cases: [string, (p: Parts) => void, RegExp][] = [
    ["recipient", (p) => { p.burn.chain2address = EVIL; }, /burn pays .* not the recipient/],
    ["chain", (p) => { p.burn.chainID = 8453n; }, /burn names chain 8453, not Arbitrum/],
    ["Portal", (p) => { p.burn.receiveSide = EVIL; }, /releases through .* not the pinned Arbitrum Portal/],
    ["Bridge", (p) => { p.burn.oppositeBridge = EVIL; }, /names bridge .* not the pinned Arbitrum Bridge/],
    ["caller", (p) => { p.burn.syntCaller = EVIL; }, /on behalf of .* not the user/],
    ["revert address", (p) => { p.burn.revertableAddress = EVIL; }, /may revert it — neither the user nor Symbiosis' revert service/],
    ["the relayers' fee eats into the minimum", (p) => { p.burn.stableBridgingFee += 1n; }, /guarantees 99197100, below the quoted minimum 99197101/],
    ["a call target without a call", (p) => { p.burn.finalReceiveSide = EVIL; }, /destination call target without a call/],
    ["an offset without a call", (p) => { p.burn.finalOffset = 36n; }, /destination call target without a call/],
  ];
  for (const [name, edit, why] of cases) it(name, () => expect(edited(n, edit)).toMatch(why));

  it("plain burnSyntheticToken is refused (the MetaRouter writes the cross-chain id over its receiver word)", () => {
    const p = open(real[n].quote.txRequest!.data!);
    const b = p.burn;
    const s = {...p.s, finalCalldata: enc("burnSyntheticToken", [b.sToken, b.amount, b.chain2address, b.receiveSide, b.oppositeBridge, b.revertableAddress, b.chainID, b.clientID])};
    const data = enc("metaRoute", [{...p.t, otherSideCalldata: enc("metaSynthesize", [s])}]);
    expect(verify(n, withTx(n, {data}))).toMatch(/does not end in metaBurnSyntheticToken \(0x[0-9a-f]{8}\)/);
  });
  it("the Symbiosis reverter on the burn is reported, not refused", () => {
    expect(bound(n, rewrite(real[n].quote, (p) => { p.s.revertableAddress = EVM; p.burn.revertableAddress = SYMBIOSIS_REVERTER; }))).toEqual({bound: {sourceSwap: null, destSwap: null, serviceReverts: true}});
  });
});

describe("point 2 — the destination call: none, the pinned Unwrapper, or a decoded swap on an allow-listed router", () => {
  const d = "tron-usdt-base-usdc";
  const final = (name: Name, fn: string, edit: (a: any[]) => void) => (p: Parts) => {
    const a = dec(p.burn.finalCallData).args;
    edit(a);
    p.burn.finalCallData = enc(fn, a);
  };
  it("a call to an arbitrary contract is refused even though the recipient's address is in it", () => {
    expect(edited("eth-usdc-arb-usdc", (p) => { p.burn.finalReceiveSide = EVIL; p.burn.finalCallData = enc("transfer", [EVM, 1n]); p.burn.finalOffset = 68n; }))
      .toMatch(/destination swap: 0x0{36}dEaD is not an allow-listed swap router/);
    expect(edited(d, (p) => { p.burn.finalReceiveSide = EVIL; })).toMatch(/is not an allow-listed swap router/);
  });
  it("another chain's V2 router is not this chain's", () => {
    expect(edited(d, (p) => { p.burn.finalReceiveSide = "0x10ED43C718714eb63d5aA57B78B54704E256024E"; })).toMatch(/is not an allow-listed swap router/);
  });
  it("another function of the allow-listed router", () => {
    expect(edited(d, (p) => { p.burn.finalCallData = enc("transfer", [EVM, 1n]); })).toMatch(/unexpected V2 router function 0xa9059cbb/);
  });
  it("receiver", () => expect(edited(d, final(d, "swapExactTokensForTokens", (a) => { a[3] = EVIL; }))).toMatch(/destination swap pays .* not the recipient/));
  it("output token", () => expect(edited(d, final(d, "swapExactTokensForTokens", (a) => { a[2] = [a[2][0], EVIL]; }))).toMatch(/buys another token than the one quoted/));
  it("input token", () => expect(edited(d, final(d, "swapExactTokensForTokens", (a) => { a[2] = [EVIL, ...a[2].slice(1)]; }))).toMatch(/sells another token than the one released/));
  it("minimum", () => expect(edited(d, final(d, "swapExactTokensForTokens", (a) => { a[1] -= 1n; }))).toMatch(/destination swap guarantees 47889480, below the quoted minimum 47889481/));
  it("no minimum", () => expect(edited(d, final(d, "swapExactTokensForTokens", (a) => { a[1] = 0n; }))).toMatch(/names no minimum/));
  it("path too long", () => expect(edited(d, final(d, "swapExactTokensForTokens", (a) => { a[2] = [a[2][0], EVIL, EVIL, EVIL, a[2][2]]; }))).toMatch(/unexpected swap path/));
  it("the released amount is written somewhere other than the swap's amount", () => {
    expect(open(real[d].quote.txRequest!.data!).burn.finalOffset).toBe(36n);
    expect(edited(d, (p) => { p.burn.finalOffset = 68n; })).toMatch(/gets the released amount written at 68, not into its amount/);
    expect(edited(d, (p) => { p.burn.finalOffset = 0n; })).toMatch(/written at 0/);
  });
  it("selling to the native coin for a token request", () => {
    expect(edited(d, final(d, "swapExactTokensForETH", () => {}))).toMatch(/buys another token than the one quoted/);
  });
  it("swapExactETHForTokens has no amount word to write into: never a destination call", () => {
    expect(edited(d, (p) => { const a = dec(p.burn.finalCallData).args; p.burn.finalCallData = enc("swapExactETHForTokens", [a[1], a[2], a[3], a[4]]); })).toMatch(/sells another token than the one released/);
  });

  describe("Unwrapper", () => {
    const u = "eth-eth-base-eth";
    it("the real route calls unwrap(amount, recipient) on Base's pinned Unwrapper with the amount word patched", () => {
      const b = open(real[u].quote.txRequest!.data!).burn;
      expect(b.finalReceiveSide).toBe(SYMBIOSIS_UNWRAPPERS[8453]!.unwrapper);
      expect(dec(b.finalCallData)).toMatchObject({name: "unwrap", args: [expect.any(BigInt), EVM]});
      expect(b.finalOffset).toBe(36n);
    });
    it("receiver", () => expect(edited(u, final(u, "unwrap", (a) => { a[1] = EVIL; }))).toMatch(/unwrap pays .* not the recipient/));
    it("offset", () => expect(edited(u, (p) => { p.burn.finalOffset = 68n; })).toMatch(/unwrap gets the released amount written at 68/));
    it("another chain's Unwrapper", () => expect(edited(u, (p) => { p.burn.finalReceiveSide = SYMBIOSIS_UNWRAPPERS[1]!.unwrapper; })).toMatch(/is not an allow-listed swap router/));
    it("another function", () => expect(edited(u, (p) => { p.burn.finalCallData = enc("transfer", [EVM, 1n]); })).toMatch(/destination unwrap: unexpected function/));
    it("an unwrap for a token request", () => {
      expect(verify(u, real[u].quote, {destToken: "0x4200000000000000000000000000000000000006"})).toMatch(/unwraps to the native coin, which is not the token quoted/);
    });
    it("the fee eats into the minimum", () => expect(edited(u, (p) => { p.burn.stableBridgingFee += 10n ** 15n; })).toMatch(/guarantees \d+, below the quoted minimum/));
    it("no call at all for a native request delivers the wrapped token: refused", () => {
      expect(edited(u, (p) => { p.burn.finalCallData = "0x"; p.burn.finalReceiveSide = "0x0000000000000000000000000000000000000000"; p.burn.finalOffset = 0n; })).toMatch(/releases another token than the one quoted/);
    });
  });

  describe("aggregator routers (encoded here from the routers' ABIs; the API offered neither when the fixtures were recorded)", () => {
    const USDBC = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA";
    const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const MIN = 47889481n;
    const oneInch = (o: Record<string, unknown> = {}) =>
      enc("swap", [EVIL, {srcToken: USDBC, dstToken: USDC, srcReceiver: EVIL, dstReceiver: EVM, amount: 49390863n, minReturnAmount: MIN, flags: 0n, ...o}, "0x1234"], ONE_INCH_ABI);
    const kyber = (o: Record<string, unknown> = {}) =>
      enc("swap", [{callTarget: EVIL, approveTarget: EVIL, targetData: "0x1234", clientData: "0x", desc: {
        srcToken: USDBC, dstToken: USDC, srcReceivers: [EVIL], srcAmounts: [0x1122334455667788n], feeReceivers: [], feeAmounts: [], dstReceiver: EVM,
        amount: 0x1122334455667788n, minReturnAmount: MIN, flags: 0x20n, permit: "0x", ...o,
      }}], KYBER_ABI);
    const put = (router: string, data: string, offset: bigint) => (p: Parts) => { p.burn.finalReceiveSide = router; p.burn.finalCallData = data; p.burn.finalOffset = offset; };

    it("1inch V6: receiver, tokens, minimum and the amount word (196) are bound", () => {
      expect(bound(d, rewrite(real[d].quote, put(SYMBIOSIS_AGGREGATORS.oneInchV6, oneInch(), 196n)))).toEqual({bound: {sourceSwap: null, destSwap: "1inch-v6", serviceReverts: true}});
      // Independent check of 196: the amount word is the only one that changes with the amount.
      const a = oneInch({amount: 1n});
      const b = oneInch({amount: 2n});
      expect([...Array(a.length).keys()].filter((i) => a[i] !== b[i]).map((i) => Math.floor((i - 2) / 2) + 1)).toEqual([196]);
    });
    const bad: [string, string, bigint, RegExp][] = [
      ["offset", oneInch(), 36n, /written at 36, not into its amount/],
      ["receiver", oneInch({dstReceiver: EVIL}), 196n, /pays .* not the recipient/],
      ["output token", oneInch({dstToken: EVIL}), 196n, /buys another token/],
      ["input token", oneInch({srcToken: EVIL}), 196n, /sells another token/],
      ["minimum", oneInch({minReturnAmount: MIN - 1n}), 196n, /guarantees 47889480/],
      ["flags (partial fill)", oneInch({flags: 1n}), 196n, /1inch swap sets flags 1/],
    ];
    for (const [name, data, offset, why] of bad) it(`1inch V6: ${name}`, () => expect(edited(d, put(SYMBIOSIS_AGGREGATORS.oneInchV6, data, offset))).toMatch(why));

    it("KyberSwap V2: the offset must be the end of desc.amount, found here by looking for the amount's bytes", () => {
      const data = kyber();
      // srcAmounts[0] carries the same value on purpose: only the word that is desc.amount is accepted.
      const hits = [...data.matchAll(/1122334455667788/g)].map((m) => (m.index! + 16 - 2) / 2);
      expect(hits.length).toBe(2);
      const accepted = hits.filter((offset) => verify(d, rewrite(real[d].quote, put(SYMBIOSIS_AGGREGATORS.kyberV2, data, BigInt(offset)))) === null);
      expect(accepted.length).toBe(1);
      const flipped = kyber({amount: 0x1122334455667789n});
      expect(data.slice(2 + accepted[0]! * 2 - 2, 2 + accepted[0]! * 2)).not.toBe(flipped.slice(2 + accepted[0]! * 2 - 2, 2 + accepted[0]! * 2));
      expect(bound(d, rewrite(real[d].quote, put(SYMBIOSIS_AGGREGATORS.kyberV2, data, BigInt(accepted[0]!))))).toEqual({bound: {sourceSwap: null, destSwap: "kyberswap-v2", serviceReverts: true}});
    });
    const kbad: [string, Record<string, unknown>, RegExp][] = [
      ["receiver", {dstReceiver: EVIL}, /pays .* not the recipient/],
      ["flags outside the accepted set", {flags: 0x10n}, /KyberSwap swap sets flags 16/],
      ["a fee receiver", {feeReceivers: [EVIL], feeAmounts: [1n]}, /pays a fee receiver/],
      ["a permit", {permit: "0x01"}, /carries a permit/],
      ["no minimum", {minReturnAmount: 0n}, /names no minimum/],
      ["output token", {dstToken: EVIL}, /buys another token/],
    ];
    for (const [name, o, why] of kbad) it(`KyberSwap V2: ${name}`, () => expect(edited(d, put(SYMBIOSIS_AGGREGATORS.kyberV2, kyber(o), 900n))).toMatch(why));
    it("another function of an aggregator router", () => {
      expect(edited(d, put(SYMBIOSIS_AGGREGATORS.oneInchV6, enc("transfer", [EVM, 1n]), 68n))).toMatch(/destination swap: unexpected function 0xa9059cbb/);
      expect(edited(d, put(SYMBIOSIS_AGGREGATORS.kyberV2, oneInch(), 196n))).toMatch(/destination swap: unexpected function 0x07ed2379/);
    });
  });
});

describe("a swap before the bridge: one decoded swap on an allow-listed router, paying the pinned MetaRouter", () => {
  const n = "bsc-usdt-ton-usdt";
  const first = (fn: string, edit: (a: any[]) => void) => (p: Parts) => {
    const a = dec(p.t.firstSwapCalldata).args;
    edit(a);
    p.t.firstSwapCalldata = enc(fn, a);
  };
  it("the real route sells USDT for USDC on PancakeSwap V2 into BNB Chain's pinned MetaRouter", () => {
    const p = open(real[n].quote.txRequest!.data!);
    expect(p.t.firstDexRouter).toBe("0x10ED43C718714eb63d5aA57B78B54704E256024E");
    expect(dec(p.t.firstSwapCalldata).args[3]).toBe(SYMBIOSIS_CHAINS["eip155:56"]!.executor);
  });
  it("router", () => expect(edited(n, (p) => { p.t.firstDexRouter = EVIL; })).toMatch(/source swap: 0x0{36}dEaD is not an allow-listed swap router/));
  it("the gateway or the token as the 'router'", () => {
    expect(edited(n, (p) => { p.t.firstDexRouter = p.t.approvedTokens[0]; })).toMatch(/not an allow-listed swap router/);
  });
  it("receiver", () => expect(edited(n, first("swapExactTokensForTokens", (a) => { a[3] = EVIL; }))).toMatch(/source swap pays .* not the pinned BNB Chain MetaRouter/));
  it("receiver = the user (the bridge would then move nothing of this swap)", () => {
    expect(edited(n, first("swapExactTokensForTokens", (a) => { a[3] = EVM; }))).toMatch(/not the pinned BNB Chain MetaRouter/);
  });
  it("sold token", () => expect(edited(n, first("swapExactTokensForTokens", (a) => { a[2] = [EVIL, a[2][1]]; }))).toMatch(/sells another token than the one requested/));
  it("bought token", () => expect(edited(n, first("swapExactTokensForTokens", (a) => { a[2] = [a[2][0], EVIL]; }))).toMatch(/does not buy the bridged token/));
  it("amount", () => expect(edited(n, first("swapExactTokensForTokens", (a) => { a[0] -= 1n; }))).toMatch(/source swap sells \d+, not 1500000000000000000000/));
  it("a minimum far below what the bridge request states", () => expect(edited(n, first("swapExactTokensForTokens", (a) => { a[1] /= 2n; }))).toMatch(/minimum is far below the amount the bridge request states/));
  it("no minimum", () => expect(edited(n, first("swapExactTokensForTokens", (a) => { a[1] = 0n; }))).toMatch(/names no minimum/));
  it("another function", () => expect(edited(n, (p) => { p.t.firstSwapCalldata = enc("transfer", [EVM, 1n]); })).toMatch(/unexpected V2 router function 0xa9059cbb/));
  it("a swap without the token it buys in the approved list", () => expect(edited(n, (p) => { p.t.approvedTokens = [p.t.approvedTokens[0]]; })).toMatch(/.+/));

  it("a native sale: swapExactETHForTokens sells the value sent; receiver, bought token and minimum are bound", () => {
    const b = "bsc-bnb-eth-eth";
    const firstEth = (edit: (a: any[]) => void) => first("swapExactETHForTokens", edit);
    expect(edited(b, firstEth((a) => { a[2] = EVIL; }))).toMatch(/not the pinned BNB Chain MetaRouter/);
    expect(edited(b, firstEth((a) => { a[1] = [a[1][0], EVIL]; }))).toMatch(/does not buy the bridged token/);
    expect(edited(b, firstEth((a) => { a[0] /= 2n; }))).toMatch(/far below/);
    expect(verify(b, withTx(b, {value: "1"}))).toMatch(/attaches 1, expected 200000000000000000/);
  });
  it("the wrap step of a native sale must call the bridged token itself", () => {
    const e = "eth-eth-base-eth";
    expect(open(real[e].quote.txRequest!.data!).t.firstSwapCalldata).toBe("0xd0e30db0");
    expect(edited(e, (p) => { p.t.firstDexRouter = EVIL; })).toMatch(/wrap step does not call the bridged token/);
    expect(edited(e, (p) => { p.t.nativeIn = false; })).toMatch(/native flag/);
  });
  it("1inch V6 as the source router: accepted with flags 0, refused with any flag or another receiver", () => {
    const p0 = open(real[n].quote.txRequest!.data!);
    const [amount, min, path] = dec(p0.t.firstSwapCalldata).args;
    const data = (o: Record<string, unknown> = {}) =>
      enc("swap", [EVIL, {srcToken: path[0], dstToken: path[1], srcReceiver: EVIL, dstReceiver: SYMBIOSIS_CHAINS["eip155:56"]!.executor, amount, minReturnAmount: min, flags: 0n, ...o}, "0x"], ONE_INCH_ABI);
    const put = (d: string) => (p: Parts) => { p.t.firstDexRouter = SYMBIOSIS_AGGREGATORS.oneInchV6; p.t.firstSwapCalldata = d; };
    expect(bound(n, rewrite(real[n].quote, put(data())))).toEqual({bound: {sourceSwap: "1inch-v6", destSwap: null, serviceReverts: true}});
    expect(edited(n, put(data({flags: 2n})))).toMatch(/1inch swap sets flags 2/);
    expect(edited(n, put(data({dstReceiver: EVM})))).toMatch(/not the pinned BNB Chain MetaRouter/);
  });
});

describe("TON destination", () => {
  const n = "bsc-usdc-ton-usdt";
  const cases: [string, (p: Parts) => void, RegExp][] = [
    ["recipient", (p) => { p.burnTon![4] = {...p.burnTon![4], address_hash: `0x${"11".repeat(32)}`}; }, /pays a TON address that is not the recipient/],
    ["workchain", (p) => { p.burnTon![4] = {...p.burnTon![4], workchain: -1}; }, /pays a TON address that is not the recipient/],
    ["chain", (p) => { p.burnTon![8] = 1n; }, /names chain 1, not TON/],
    ["receive side", (p) => { p.burnTon![5] = EVIL; }, /unexpected receive side or bridge/],
    ["bridge", (p) => { p.burnTon![6] = EVIL; }, /unexpected receive side or bridge/],
    ["token", (p) => { p.burnTon![1] = "0xc317169a336b484f65B0AB4A794bBe66a7491E83"; }, /burn names another token/],
    ["revert address", (p) => { p.burnTon![7] = EVIL; }, /may revert it/],
    ["fee", (p) => { p.burnTon![0] += 1n; }, /guarantees \d+, below the quoted minimum/],
  ];
  for (const [name, edit, why] of cases) it(name, () => expect(edited(n, edit)).toMatch(why));
  it("an EVM burn for a TON request", () => {
    const p = open(real["eth-usdc-arb-usdc"].quote.txRequest!.data!);
    const q = open(real[n].quote.txRequest!.data!);
    const s = {...q.s, finalCalldata: enc("metaBurnSyntheticToken", [p.burn])};
    expect(verify(n, withTx(n, {data: enc("metaRoute", [{...q.t, otherSideCalldata: enc("metaSynthesize", [s])}])}))).toMatch(/TON destination must end in burnSyntheticTokenTON/);
  });
  it("another jetton than the one quoted", () => {
    expect(verify(n, real[n].quote, {destToken: "EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT"})).toMatch(/releases another token|not in the catalog/);
  });
});

describe("Tron source", () => {
  const n = "tron-usdt-base-usdc";
  it("contract: base58 of the pinned gateway only", () => {
    expect(real[n].quote.txRequest!.to).toBe("TPuaJ6gnYfE9gLUDFrbWbPx3tMnjG8max1");
    expect(verify(n, withTx(n, {to: "TD4tamFrCq7KvQEB1LArNXr9sKFC6GaAmt"}))).toMatch(/calls TD4tamFrCq7KvQEB1LArNXr9sKFC6GaAmt, not the pinned Tron MetaRouterGateway/);
    expect(verify(n, withTx(n, {to: "not-base58"}))).toMatch(/not the pinned Tron MetaRouterGateway/);
  });
  it("spender: the gateway in base58, exactly", () => {
    expect(verify(n, withTx(n, {approvalAddress: "TD4tamFrCq7KvQEB1LArNXr9sKFC6GaAmt"}))).toMatch(/approval names/);
    expect(verify(n, withTx(n, {approvalAddress: "tpuaj6gnyfe9gludfrbwbpx3tmnjg8max1"}))).toMatch(/does not name the pinned Tron MetaRouterGateway/);
  });
  it("value and chain", () => {
    expect(verify(n, withTx(n, {value: "1"}))).toMatch(/attaches 1, expected 0/);
    expect(verify(n, withTx(n, {chainId: 1}))).toMatch(/for chain 1, not Tron/);
  });
  it("the same calldata rules: caller is the sender's 20 bytes, no swap on Tron", () => {
    expect(edited(n, (p) => { p.s.syntCaller = EVIL; })).toMatch(/not the sender/);
    expect(edited(n, (p) => { p.t.firstDexRouter = EVIL; p.t.firstSwapCalldata = "0x00"; p.t.approvedTokens = [p.t.approvedTokens[0], p.t.approvedTokens[0]]; })).toMatch(/no aggregator router is allow-listed on Tron/);
    expect(edited(n, (p) => { p.t.relayRecipient = EVIL; })).toMatch(/not the pinned Tron Portal/);
  });
  it("Tron → TON needs the user's own EVM address, and no other address may stand in the route", () => {
    const t = "tron-usdt-ton-usdt";
    expect(symbiosisVerifyQuote(real[t].params, real[t].quote, {})).toMatch(/needs the user's own EVM address \(fallbackReceiver\)/);
    expect(symbiosisVerifyQuote(real[t].params, real[t].quote, {fallbackReceiver: EVIL})).toMatch(/names 0x28C6c06298d514Db089934071355E5743bf21d60 as the address that may revert it/);
  });
});

// ── TON source: the message body, rebuilt with @ton/core around one edit ──────────────────────
interface TonBody {op: number; query: bigint; amount: bigint; dest: Address; excess: Address; custom: boolean; forward: bigint; inRef: boolean; request: Cell}
const tonOpen = (boc: string): TonBody => {
  const s = Cell.fromBase64(boc).beginParse();
  return {op: s.loadUint(32), query: s.loadUintBig(64), amount: s.loadCoins(), dest: s.loadAddress(), excess: s.loadAddress(), custom: s.loadBit(), forward: s.loadCoins(), inRef: s.loadBit(), request: s.loadRef()};
};
const tonClose = (b: TonBody): string =>
  beginCell().storeUint(b.op, 32).storeUint(b.query, 64).storeCoins(b.amount).storeAddress(b.dest).storeAddress(b.excess).storeBit(b.custom).storeCoins(b.forward).storeBit(b.inRef).storeRef(b.request).endCell().toBoc().toString("base64");
interface TonRequest {op: number; head: Cell; sides: Cell; tail: Cell}
const reqOpen = (c: Cell): TonRequest => { const s = c.beginParse(); return {op: s.loadUint(32), head: s.loadRef(), sides: s.loadRef(), tail: s.loadRef()}; };
const reqClose = (r: TonRequest): Cell => beginCell().storeUint(r.op, 32).storeRef(r.head).storeRef(r.sides).storeRef(r.tail).endCell();
const h160 = (a: string) => BigInt(a);
/** EVM calldata as the API stores it: zero-padded to a multiple of 32 bytes, chained through single references. */
const snake = (hex: string): Cell => {
  const raw = Buffer.from(hex.replace(/^0x/, ""), "hex");
  const bytes = Buffer.concat([raw, Buffer.alloc((32 - (raw.length % 32)) % 32)]);
  const chunks: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += 127) chunks.push(bytes.subarray(i, i + 127));
  let cell: Cell | null = null;
  for (let i = chunks.length - 1; i >= 0; i--) {
    const b = beginCell().storeBuffer(chunks[i]!);
    if (cell) b.storeRef(cell);
    cell = b.endCell();
  }
  return cell ?? beginCell().endCell();
};
const unsnake = (c: Cell, length: number): string => {
  let out = Buffer.alloc(0);
  for (let cur: Cell | undefined = c; cur; cur = cur.refs[0]) { const s = cur.beginParse(); out = Buffer.concat([out, s.loadBuffer(s.remainingBits / 8)]); }
  return `0x${out.subarray(0, length).toString("hex")}`;
};

describe("TON source: one jetton transfer to the pinned Portal carrying the bridge request", () => {
  const n = "ton-usdt-tron-usdt";
  const msg = () => ({to: real[n].quote.providerData!.tonTo!, value: real[n].quote.providerData!.tonValue!, body: real[n].quote.providerData!.tonBody!});
  const withBody = (body: string, more: Record<string, string> = {}): Quote => ({...real[n].quote, providerData: {...real[n].quote.providerData!, tonBody: body, ...more}});
  const body = (edit: (b: TonBody) => void) => { const b = tonOpen(msg().body); edit(b); return verify(n, withBody(tonClose(b))); };
  const request = (edit: (r: TonRequest) => void) => body((b) => { const r = reqOpen(b.request); edit(r); b.request = reqClose(r); });
  const other = Address.parse("EQBZh9CpLZyNlwI7am0PHpVy8T8zdJxAhlG3m3xMi0BoVaUh".replace("EQBZ", "EQBZ")); // the Portal itself
  const stranger = Address.parseRaw(`0:${"ab".repeat(32)}`);

  it("the real body, rebuilt by @ton/core's own serializer, is read the same way", () => {
    const b = tonOpen(msg().body);
    expect(b.op).toBe(0x0f8a7ea5);
    expect(b.amount).toBe(50_000_000n);
    expect(b.dest.equals(other)).toBe(true);
    expect(b.excess.equals(Address.parse(real[n].params.refundAddress!))).toBe(true);
    expect(verify(n, withBody(tonClose(b)))).toBeNull();
  });
  it("destination", () => expect(body((b) => { b.dest = stranger; })).toMatch(/does not go to the pinned TON Portal/));
  it("amount", () => expect(body((b) => { b.amount += 1n; })).toMatch(/transfer moves 50000001, not 50000000/));
  it("excess address", () => expect(body((b) => { b.excess = stranger; })).toMatch(/excess does not return to the sender/));
  it("custom payload flag", () => expect(body((b) => { b.custom = true; })).toMatch(/custom payload|not a Symbiosis bridge request/));
  it("another op", () => expect(body((b) => { b.op = 0x595f07bc; })).toMatch(/not a jetton transfer/));
  it("forwarding more than is attached", () => expect(body((b) => { b.forward = 10n ** 9n; })).toMatch(/forwards more TON than the message attaches/));
  it("a payload that is not the bridge request", () => expect(request((r) => { r.op = 1; })).toMatch(/forward payload is not a Symbiosis bridge request/));
  it("attached value above the ceiling, or none", () => {
    expect(verify(n, withBody(msg().body, {tonValue: (SYMBIOSIS_TON_VALUE_CEILING + 1n).toString()}))).toMatch(/attaches 1000000001 nanotons, above the 1000000000 ceiling/);
    expect(verify(n, withBody(msg().body, {tonValue: "0"}))).toMatch(/attaches 0 nanotons/);
    expect(verify(n, withBody(msg().body, {tonValue: "0x10"}))).toMatch(/not a number/);
  });
  it("a body that is not a bag of cells, or one with bytes left over", () => {
    expect(verify(n, withBody("AAAA"))).toMatch(/does not parse/);
    expect(verify(n, withBody(Buffer.concat([Buffer.from(msg().body, "base64"), Buffer.from([0])]).toString("base64")))).toMatch(/does not parse/);
  });
  it("a message addressed to nothing", () => expect(verify(n, withBody(msg().body, {tonTo: "0x1234"}))).toMatch(/not addressed to a TON account/));
  it("calldata or a deposit address next to the message", () => {
    expect(verify(n, {...real[n].quote, txRequest: {to: EVIL, data: "0x", value: "0"}})).toMatch(/a TON source carries one jetton transfer/);
    expect(verify(n, {...real[n].quote, depositAddress: "UQ"})).toMatch(/a TON source carries one jetton transfer/);
  });

  // head: fee, jetton master, amount, the user's host-chain address
  const head = (edit: (h: {fee: bigint; master: Address; amount: bigint; credit: bigint}) => void) => request((r) => {
    const s = r.head.beginParse();
    const h = {fee: s.loadCoins(), master: s.loadAddress(), amount: s.loadCoins(), credit: s.loadUintBig(160)};
    edit(h);
    r.head = beginCell().storeCoins(h.fee).storeAddress(h.master).storeCoins(h.amount).storeUint(h.credit, 160).endCell();
  });
  it("jetton", () => expect(head((h) => { h.master = stranger; })).toMatch(/names a jetton that is not the sell token/));
  it("bridged amount", () => expect(head((h) => { h.amount -= 1n; })).toMatch(/moves an amount that is not the sell amount/));
  it("host-chain credit", () => expect(head((h) => { h.credit = h160(EVIL); })).toMatch(/credits .* not one of the user's addresses/));
  it("a fee that takes everything", () => expect(head((h) => { h.fee = h.amount; })).toMatch(/fee takes the whole amount/));

  // sides: Synthesis, Bridge, chain id, final receive side
  const sides = (edit: (x: bigint[]) => void) => request((r) => {
    const s = r.sides.beginParse();
    const x = [s.loadUintBig(160), s.loadUintBig(160), s.loadUintBig(256), s.loadUintBig(160)];
    edit(x);
    r.sides = beginCell().storeUint(x[0]!, 160).storeUint(x[1]!, 160).storeUint(x[2]!, 256).storeUint(x[3]!, 160).endCell();
  });
  it("host Synthesis / Bridge / chain", () => {
    expect(sides((x) => { x[0] = h160(EVIL); })).toMatch(/pinned host-chain Synthesis/);
    expect(sides((x) => { x[1] = h160(EVIL); })).toMatch(/pinned host-chain Bridge/);
    expect(sides((x) => { x[2] = 1n; })).toMatch(/targets chain 1/);
    expect(sides((x) => { x[3] = h160(EVIL); })).toMatch(/pinned host-chain Synthesis/);
  });

  // tail: final offset, revert address, final length, router, swap length; refs: tokens, final calldata, pool calldata
  interface Tail {offset: bigint; revert: bigint; finalLen: bigint; router: bigint; secondLen: bigint; tokens: Cell; final: Cell; second: Cell}
  const tail = (edit: (t: Tail) => void) => request((r) => {
    const s = r.tail.beginParse();
    const t: Tail = {offset: s.loadUintBig(256), revert: s.loadUintBig(160), finalLen: s.loadUintBig(64), router: s.loadUintBig(160), secondLen: s.loadUintBig(64), tokens: s.loadRef(), final: s.loadRef(), second: s.loadRef()};
    edit(t);
    r.tail = beginCell().storeUint(t.offset, 256).storeUint(t.revert, 160).storeUint(t.finalLen, 64).storeUint(t.router, 160).storeUint(t.secondLen, 64).storeRef(t.tokens).storeRef(t.final).storeRef(t.second).endCell();
  });
  const setFinal = (t: Tail, edit: (burn: any) => void) => {
    const b = dec(unsnake(t.final, Number(t.finalLen))).args[0];
    edit(b);
    const data = enc("metaBurnSyntheticToken", [b]);
    t.final = snake(data);
    t.finalLen = BigInt((data.length - 2) / 2);
  };
  const setPools = (t: Tail, edit: (mc: any[], pool: any[]) => void) => {
    const mc = dec(unsnake(t.second, Number(t.secondLen))).args;
    const pool = dec(mc[1][0]).args;
    edit(mc, pool);
    mc[1] = [enc("swap", pool)];
    const data = enc("multicall", mc);
    t.second = snake(data);
    t.secondLen = BigInt((data.length - 2) / 2);
  };
  it("the calldata cells survive the test's own snake writer unchanged", () => expect(tail((t) => { setFinal(t, () => {}); setPools(t, () => {}); })).toBeNull());
  it("revert address", () => expect(tail((t) => { t.revert = h160(EVIL); })).toMatch(/lets .* revert it/));
  it("final offset", () => expect(tail((t) => { t.offset = 68n; })).toMatch(/unexpected amount offset 68/));
  it("the multicall target", () => expect(tail((t) => { t.router = h160(EVIL); })).toMatch(/not the pinned MulticallRouter/));
  it("a stated length that is not the stored calldata", () => expect(tail((t) => { t.finalLen += 40n; })).toMatch(/not a Symbiosis bridge request|does not decode|canonically/));
  it("the minted synthetic", () => expect(tail((t) => { t.tokens = beginCell().storeUint(h160(EVIL), 160).storeUint(h160(EVIL), 160).endCell(); })).toMatch(/does not start from the pinned synthetic/));
  it("three swap tokens", () => expect(tail((t) => { t.tokens = beginCell().storeUint(1n, 160).storeUint(2n, 160).storeUint(3n, 160).endCell(); })).toMatch(/malformed swap token list/));
  it("the burn's recipient (Tron)", () => expect(tail((t) => setFinal(t, (b) => { b.chain2address = EVIL; }))).toMatch(/burn pays .* not the recipient/));
  it("the burn's Portal", () => expect(tail((t) => setFinal(t, (b) => { b.receiveSide = EVIL; }))).toMatch(/not the pinned Tron Portal/));
  it("a destination call on Tron", () => expect(tail((t) => setFinal(t, (b) => { b.finalReceiveSide = EVIL; b.finalCallData = enc("transfer", [EVM, 1n]); b.finalOffset = 68n; }))).toMatch(/no aggregator router is allow-listed on Tron/));
  it("a pool that is not pinned", () => expect(tail((t) => setPools(t, (mc) => { mc[2] = [EVIL]; }))).toMatch(/not a pinned Symbiosis pool/));
  it("the pool's minimum", () => expect(tail((t) => setPools(t, (_mc, pool) => { pool[3] -= 1n; }))).toMatch(/guarantees \d+, below the quoted minimum/));
  it("the multicall's receiver", () => expect(tail((t) => setPools(t, (mc) => { mc[5] = EVIL; }))).toMatch(/not the pinned host-chain MetaRouter/));

  it("TON → Base with a destination swap: the swap's receiver and minimum are bound through the cells too", () => {
    const b = "ton-usdt-base-usdc";
    const run = (edit: (a: any[]) => void) => {
      const bodyB = tonOpen(real[b].quote.providerData!.tonBody!);
      const r = reqOpen(bodyB.request);
      const s = r.tail.beginParse();
      const t: Tail = {offset: s.loadUintBig(256), revert: s.loadUintBig(160), finalLen: s.loadUintBig(64), router: s.loadUintBig(160), secondLen: s.loadUintBig(64), tokens: s.loadRef(), final: s.loadRef(), second: s.loadRef()};
      setFinal(t, (burn) => { const a = dec(burn.finalCallData).args; edit(a); burn.finalCallData = enc("swapExactTokensForTokens", a); });
      r.tail = beginCell().storeUint(t.offset, 256).storeUint(t.revert, 160).storeUint(t.finalLen, 64).storeUint(t.router, 160).storeUint(t.secondLen, 64).storeRef(t.tokens).storeRef(t.final).storeRef(t.second).endCell();
      bodyB.request = reqClose(r);
      return verify(b, {...real[b].quote, providerData: {...real[b].quote.providerData!, tonBody: tonClose(bodyB)}});
    };
    expect(run(() => {})).toBeNull();
    expect(run((a) => { a[3] = EVIL; })).toMatch(/destination swap pays .* not the recipient/);
    expect(run((a) => { a[1] -= 1n; })).toMatch(/destination swap guarantees \d+, below the quoted minimum/);
  });
});

describe("the build, right before signing", () => {
  const n = "eth-usdc-arb-usdc";
  const build = (name: Name, o: Record<string, unknown> = {}) => {
    const tx = real[name].quote.txRequest!;
    return {chain: real[name].params.sourceChain, to: tx.to!, value: tx.value ?? "0", data: tx.data, chainId: tx.chainId, ...(tx.approvalAddress ? {approvalAddress: tx.approvalAddress} : {}), ...o} as never;
  };
  it("the quoted transaction passes; any change to it is caught by the same checks", () => {
    expect(symbiosisVerifyBuild(real[n].quote, build(n), real[n].params, OPTIONS)).toBeNull();
    expect(symbiosisVerifyBuild(real[n].quote, build(n, {to: EVIL}), real[n].params, OPTIONS)).toMatch(/not the pinned Ethereum MetaRouterGateway/);
    expect(symbiosisVerifyBuild(real[n].quote, build(n, {value: "5"}), real[n].params, OPTIONS)).toMatch(/attaches 5/);
    expect(symbiosisVerifyBuild(real[n].quote, build(n, {approvalAddress: EVIL}), real[n].params, OPTIONS)).toMatch(/approval names/);
    expect(symbiosisVerifyBuild(real[n].quote, build(n, {chain: "eip155:56"}), real[n].params, OPTIONS)).toMatch(/another chain/);
    expect(symbiosisVerifyBuild(real[n].quote, build(n, {data: rewrite(real[n].quote, (p) => { p.burn.chain2address = EVIL; }).txRequest!.data}), real[n].params, OPTIONS)).toMatch(/not the recipient/);
  });
  it("parts this route never has", () => {
    for (const extra of [{serializedTx: "00"}, {stateInitBoc: "te6c"}, {typedData: {}}, {memo: "x"}]) {
      expect(symbiosisVerifyBuild(real[n].quote, build(n, extra), real[n].params, OPTIONS)).toMatch(/carries a part this route never has/);
    }
  });
  it("without the request nothing can be checked", () => expect(symbiosisVerifyBuild(real[n].quote, build(n))).toMatch(/cannot be checked without the request/));
  it("a TON build is the message; calldata on it is refused", () => {
    const t = "ton-usdt-tron-usdt";
    const d = real[t].quote.providerData!;
    const tx = {chain: "ton:-239", to: d.tonTo!, value: d.tonValue!, bodyBoc: d.tonBody!};
    expect(symbiosisVerifyBuild(real[t].quote, tx, real[t].params, OPTIONS)).toBeNull();
    expect(symbiosisVerifyBuild(real[t].quote, {...tx, data: "0x"}, real[t].params, OPTIONS)).toMatch(/carries no calldata or approval/);
    expect(symbiosisVerifyBuild(real[t].quote, {...tx, value: "2000000000"}, real[t].params, OPTIONS)).toMatch(/ceiling/);
    expect(symbiosisVerifyBuild(real[t].quote, {chain: "ton:-239", to: d.tonTo!, value: d.tonValue!}, real[t].params, OPTIONS)).toMatch(/needs a message body/);
  });
});

void ABI;

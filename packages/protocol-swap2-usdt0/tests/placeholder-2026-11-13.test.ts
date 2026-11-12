// Review r3 of the Legacy Mesh branch (2026-11-13): a quote without `destAddress` (dry is the default) was built as a
// full `send` to the provider's stand-in — the zero account on Tron (T9yD14…) or TON (0:000…0), vitalik.eth between EVM
// chains — refunding vitalik.eth when the refund address was missing too, and both buildDeposit and preflightDeposit
// passed it: a direct integrator who signed it burned the USDT (or paid it to vitalik.eth). A live quote to a recipient
// typed as the zero account was quoted and built as well. Now a quote priced for a stand-in keeps only its price (no
// txRequest, `providerData.placeholder`), buildDeposit / preflightDeposit / usdt0VerifyQuote refuse it with new texts, and
// a zero-account recipient is refused. Fake JSON-RPC + Scan behind fetch (fixtures.ts, mesh-fixtures.ts); nothing is
// signed or sent.
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeFunctionData, pad, type Hex} from "viem";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {remotePinRefusal} from "@anywalletkit/protocol-swap2-core/validate";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {Usdt0Swap2Protocol} from "../src/protocol.js";
import {USDT0_MESH_PLACEHOLDER, tronAddressOf, usdt0Pins, usdt0VerifyQuote} from "../src/config.js";
import {ARB, ETH, HYPE, OFT_ABI, PARAMS, SEALED, SENDER, make as oftMake} from "./fixtures.js";
import {
  ABI as MESH_ABI, ARB as MARB, CELO, ETH as METH, FEE_TON, FEE_TRON, RPC as MESH_RPC, TON, TON_TO, TO_TON, TO_TRON, TRON, make as meshMake, sealedOf,
} from "./mesh-fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ATTACKER = "0x9999999999999999999999999999999999999999";
const ZERO_EVM = "0x0000000000000000000000000000000000000000";
const ZERO_B32 = `0x${"00".repeat(32)}` as Hex;
const words = (role: string) => (role === "refund" ? "refund address" : role);
const BUILD = (role: string) => `swap2: this USDT0 quote was priced for a placeholder ${words(role)} (a dry quote without that address) and has no transaction to build — quote again with the recipient and the refund address`;
const PREFLIGHT = (role: string) => `usdt0: this quote was priced for a placeholder ${words(role)} (a dry quote without that address) and has nothing to sign — quote again with the recipient and the refund address`;
const CARRIES = (role: string) => `a dry quote priced for a placeholder ${words(role)} carries a transaction — it would pay or refund that placeholder, not the wallet that signs it`;
const ZERO = "destination is the zero account — nothing sent there can be recovered";

/** A user-friendly TON address (tag 0x11 bounceable / 0x51 non-bounceable, workchain 0) of a 32-byte account hash. */
function friendly(tag: number, hash: Uint8Array): string {
  const b = new Uint8Array(36);
  b[0] = tag; b[1] = 0; b.set(hash, 2);
  let crc = 0;
  for (const x of b.subarray(0, 34)) { crc ^= x << 8; for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
  b[34] = crc >> 8; b[35] = crc & 0xff;
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_");
}

/** OFT (EVM → EVM) and Legacy Mesh requests, each with a provider over the fake RPC. */
const OFT = {...PARAMS, dry: false} as QuoteParams;
const MESH_TRON = TO_TRON;
const MESH_TON = TO_TON;
type Kind = "oft" | "mesh";
const providerFor = (kind: Kind) => (kind === "oft" ? oftMake() : meshMake());
async function quoteOf(kind: Kind, params: QuoteParams) {
  const {p, calls} = providerFor(kind);
  const reasons: string[] = [];
  const q = await p.getQuote({...params, onRefusal: (r) => reasons.push(r)});
  return {q, reasons, p, calls};
}
const dryOf = (params: QuoteParams, drop: {dest?: boolean; refund?: boolean}, dry: boolean | undefined = true): QuoteParams => {
  const {refundAddress, dry: _dry, ...rest} = params;
  return {...rest, destAddress: drop.dest ? "" : params.destAddress, ...(drop.refund ? {} : {refundAddress}), ...(dry === undefined ? {} : {dry})};
};
/** Re-encode the send of a quote (either ABI decodes `send`). */
function resend(q: Quote, f: (sp: Record<string, unknown>, rest: {fee: {nativeFee: bigint; lzTokenFee: bigint}; refund: string}) => void): Quote {
  const [sp0, fee, refund] = decodeFunctionData({abi: OFT_ABI, data: q.txRequest!.data as Hex}).args as unknown as [Record<string, unknown>, {nativeFee: bigint; lzTokenFee: bigint}, string];
  const sp = {...sp0};
  const rest = {fee: {...fee}, refund};
  f(sp, rest);
  return {...q, txRequest: {...q.txRequest!, data: encodeFunctionData({abi: OFT_ABI, functionName: "send", args: [sp as never, rest.fee, rest.refund as Hex]})}};
}

describe("a dry quote priced for a placeholder carries no transaction (getQuote)", () => {
  const cases: [string, Kind, QuoteParams, "recipient" | "refund", string, string][] = [
    ["OFT Arbitrum → HyperEVM, the refund address but no recipient", "oft", dryOf(OFT, {dest: true}), "recipient", `usdt0:${ARB.eid}:${HYPE.eid}`, SEALED.toString()],
    ["OFT Arbitrum → HyperEVM, the recipient but no refund address", "oft", dryOf(OFT, {refund: true}), "refund", `usdt0:${ARB.eid}:${HYPE.eid}`, SEALED.toString()],
    ["OFT Arbitrum → HyperEVM, neither address (dry by default)", "oft", dryOf(OFT, {dest: true, refund: true}, undefined), "recipient", `usdt0:${ARB.eid}:${HYPE.eid}`, SEALED.toString()],
    ["OFT Ethereum adapter → Arbitrum, no recipient", "oft", dryOf({...OFT, sourceChain: "eip155:1", sourceToken: "USDT", destChain: "eip155:42161", destToken: ARB.token}, {dest: true}), "recipient", `usdt0:${ETH.eid}:${ARB.eid}`, SEALED.toString()],
    ["mesh Arbitrum → Tron, the refund address but no recipient (the zero account T9yD14…)", "mesh", dryOf(MESH_TRON, {dest: true}), "recipient", `usdt0-mesh:${MARB.eid}:${TRON.eid}`, sealedOf(FEE_TRON).toString()],
    ["mesh Arbitrum → TON, the recipient but no refund address", "mesh", dryOf(MESH_TON, {refund: true}), "refund", `usdt0-mesh:${MARB.eid}:${TON.eid}`, sealedOf(FEE_TON).toString()],
    ["mesh Celo USD₮ → Tron, neither address", "mesh", dryOf({...MESH_TRON, sourceChain: "eip155:42220", sourceToken: CELO.token}, {dest: true, refund: true}), "recipient", `usdt0-mesh:${CELO.eid}:${TRON.eid}`, sealedOf(FEE_TRON).toString()],
    ["mesh Ethereum → TON, no recipient, dry by default (the zero account 0:000…0)", "mesh", dryOf({...MESH_TON, sourceChain: "eip155:1", sourceToken: "USDT"}, {dest: true}, undefined), "recipient", `usdt0-mesh:${METH.eid}:${TON.eid}`, sealedOf(FEE_TON).toString()],
  ];
  for (const [name, kind, params, role, intent, nativeFee] of cases) {
    it(name, async () => {
      const {q, reasons, p} = await quoteOf(kind, params);
      expect(reasons).toEqual([]);
      expect(q!.txRequest).toBeUndefined();
      // The price stays: what is spent, what arrives, the fee rows, the sealed LayerZero fee for display.
      expect(q).toMatchObject({provider: "usdt0", intentId: intent, depositAddress: "", sourceAmount: params.amountIn});
      expect(BigInt(q!.destAmount)).toBeGreaterThan(0n);
      expect(q!.providerData).toMatchObject({placeholder: role, amountLD: params.amountIn, minAmountLD: q!.minDestAmount, nativeFee});
      // The stand-in's addresses are not sealed: nothing to build or preflight from.
      for (const k of ["recipient", "recipientBytes32", "refundAddress"]) expect(q!.providerData![k], k).toBeUndefined();
      await expect(p.buildDeposit(q!)).rejects.toThrow(BUILD(role));
      expect(usdt0VerifyQuote(params, q!)).toBeNull();
    });
  }

  it("a dry quote naming both addresses, and a live one, still carry the send (built for those addresses)", async () => {
    for (const [kind, live] of [["oft", OFT], ["mesh", MESH_TRON], ["mesh", MESH_TON]] as const) {
      for (const params of [live, {...live, dry: true}, dryOf(live, {}, undefined)]) {
        const {q, reasons, p} = await quoteOf(kind, params);
        expect([kind, params.dry, reasons]).toEqual([kind, params.dry, []]);
        expect(q!.providerData!.placeholder).toBeUndefined();
        expect(q!.txRequest!.data).toMatch(/^0x/);
        const tx = await p.buildDeposit(q!);
        await expect(p.preflightDeposit!(q!, tx)).resolves.toBeUndefined();
        expect(usdt0VerifyQuote(params, q!)).toBeNull();
      }
    }
  });
});

describe("buildDeposit and preflightDeposit refuse a quote priced for a placeholder", () => {
  it("buildDeposit: by name, also with a send attached; an unmarked quote without one keeps the existing refusal", async () => {
    for (const [kind, live] of [["oft", OFT], ["mesh", MESH_TRON]] as const) {
      const {p} = providerFor(kind);
      const priced = (await p.getQuote(dryOf(live, {dest: true})))!;
      const real = (await p.getQuote(live))!;
      await expect(p.buildDeposit({...priced, txRequest: real.txRequest!})).rejects.toThrow(BUILD("recipient"));
      await expect(p.buildDeposit({...real, providerData: {...real.providerData, placeholder: "refund"}})).rejects.toThrow(BUILD("refund"));
      // Any value in the mark refuses; it is never echoed.
      await expect(p.buildDeposit({...real, providerData: {...real.providerData, placeholder: "<script>"}})).rejects.toThrow(BUILD("address"));
      const {providerData: {placeholder: _mark, ...rest}} = priced as {providerData: Record<string, string>};
      await expect(p.buildDeposit({...priced, providerData: rest})).rejects.toThrow("swap2: USDT0 quote has no transaction request");
      // The live quote builds as before.
      await expect(p.buildDeposit(real)).resolves.toMatchObject({to: real.txRequest!.to, data: real.txRequest!.data});
    }
  });

  it("preflightDeposit: by name before any RPC read, also with a real send attached; without the mark the sealed parameters are missing", async () => {
    for (const [kind, live] of [["oft", OFT], ["mesh", MESH_TRON], ["mesh", MESH_TON]] as const) {
      const {p, calls} = providerFor(kind);
      const priced = (await p.getQuote(dryOf(live, {refund: true})))!;
      const real = (await p.getQuote(live))!;
      const tx = await p.buildDeposit(real);
      const before = calls.length;
      await expect(p.preflightDeposit!(priced, tx)).rejects.toThrow(PREFLIGHT("refund"));
      await expect(p.preflightDeposit!({...priced, txRequest: real.txRequest!}, tx)).rejects.toThrow(PREFLIGHT("refund"));
      await expect(p.preflightDeposit!({...real, providerData: {...real.providerData, placeholder: "recipient"}}, tx)).rejects.toThrow(PREFLIGHT("recipient"));
      expect(calls.length).toBe(before);
      const {providerData: {placeholder: _mark, ...rest}} = priced as {providerData: Record<string, string>};
      await expect(p.preflightDeposit!({...priced, providerData: rest}, tx)).rejects.toThrow("usdt0: quote carries no sealed send parameters");
      await expect(p.preflightDeposit!(real, tx)).resolves.toBeUndefined();
    }
  });
});

describe("usdt0VerifyQuote: a dry request priced for a placeholder refuses any transaction", () => {
  it("OFT: the send the provider used to build for vitalik.eth, and the real send, for a request without one of the addresses", async () => {
    const real = (await quoteOf("oft", OFT)).q!;
    const stand = resend(real, (sp, r) => { sp.to = pad(VITALIK, {size: 32}); r.refund = VITALIK; });
    expect(usdt0VerifyQuote(dryOf(OFT, {dest: true, refund: true}), stand)).toBe(CARRIES("recipient"));
    expect(usdt0VerifyQuote(dryOf(OFT, {dest: true}), resend(real, (sp) => { sp.to = pad(VITALIK, {size: 32}); }))).toBe(CARRIES("recipient"));
    expect(usdt0VerifyQuote(dryOf(OFT, {refund: true}), real)).toBe(CARRIES("refund"));
    // dry: undefined is dry, as in the provider.
    expect(usdt0VerifyQuote(dryOf(OFT, {dest: true}, undefined), stand)).toBe(CARRIES("recipient"));
    // A live request without the recipient is still held to it.
    expect(usdt0VerifyQuote({...OFT, destAddress: ""}, stand)).toBe("the recipient is not an EVM address");
  });

  it("mesh: the zero-account send for Tron and TON, and a real send for a request without the refund address", async () => {
    for (const live of [MESH_TRON, MESH_TON]) {
      const real = (await quoteOf("mesh", live)).q!;
      const stand = resend(real, (sp, r) => { sp.to = ZERO_B32; r.refund = VITALIK; });
      expect(usdt0VerifyQuote(dryOf(live, {dest: true, refund: true}), stand)).toBe(CARRIES("recipient"));
      expect(usdt0VerifyQuote(dryOf(live, {dest: true}, undefined), stand)).toBe(CARRIES("recipient"));
      expect(usdt0VerifyQuote(dryOf(live, {refund: true}), real)).toBe(CARRIES("refund"));
      expect(usdt0Pins.verifyQuote!(dryOf(live, {dest: true}), stand)).toBe(CARRIES("recipient"));
    }
  });

  it("a price-only quote is still held to the request's amount, floor, output and route; a request naming both addresses needs its send", async () => {
    for (const [kind, live, other] of [["oft", OFT, `usdt0:${ARB.eid}:${ETH.eid}`], ["mesh", MESH_TRON, `usdt0:${MARB.eid}:${HYPE.eid}`]] as const) {
      const params = dryOf(live, {dest: true});
      const q = (await quoteOf(kind, params)).q!;
      expect(usdt0VerifyQuote(params, q)).toBeNull();
      expect(usdt0VerifyQuote(params, {...q, intentId: `${q.intentId}~${"ab".repeat(16)}`})).toBeNull(); // the server's tokened id
      expect(usdt0VerifyQuote(params, {...q, sourceAmount: "1"})).toBe(`the quote spends 1, not the ${params.amountIn} input`);
      expect(usdt0VerifyQuote({...params, minAmountOut: (BigInt(q.minDestAmount) + 1n).toString()}, q)).toBe(`the quoted minimum ${q.minDestAmount} is below the caller's floor ${BigInt(q.minDestAmount) + 1n}`);
      expect(usdt0VerifyQuote(params, {...q, destAmount: "10000001"})).toBe(`the quote delivers more than the ${params.amountIn} input`);
      expect(usdt0VerifyQuote(params, {...q, minDestAmount: "10000001", destAmount: "10000001"})).toBe(`the quote delivers more than the ${params.amountIn} input`);
      expect(usdt0VerifyQuote(params, {...q, minDestAmount: "10000001"})).toBe(`the quote delivers more than the ${params.amountIn} input`);
      expect(usdt0VerifyQuote(params, {...q, minDestAmount: "1.5"})).toBe("the quote's amounts are not integers");
      expect(usdt0VerifyQuote({...params, amountIn: "1e7"}, q)).toBe("the quote's amounts are not integers");
      expect(usdt0VerifyQuote(params, {...q, depositAddress: ATTACKER})).toBe(`a USDT0 quote pays no deposit address, but this one names ${ATTACKER}`);
      expect(usdt0VerifyQuote(params, {...q, intentId: other})).toBe("the intent id does not name this send");
      // Tokens are checked first, as for a send.
      expect(usdt0VerifyQuote({...params, sourceToken: "USDC"}, q)).toMatch(/^source token USDC is not USDT0/);
      // With both addresses named (dry or live) the existing refusal: the quote must carry the send.
      expect(usdt0VerifyQuote(live, q)).toBe("the quote carries no OFT call");
      expect(usdt0VerifyQuote({...live, dry: true}, q)).toBe("the quote carries no OFT call");
    }
  });
});

describe("a recipient that is the zero account is refused, dry or live", () => {
  const zeroTon = new Uint8Array(32);
  const tonZeroFriendly = [friendly(0x11, zeroTon), friendly(0x51, zeroTon)];

  it("spells the zero accounts the way their chains do", () => {
    expect(tronAddressOf(new Uint8Array(20))).toBe(USDT0_MESH_PLACEHOLDER.tron);
    expect(USDT0_MESH_PLACEHOLDER.tron).toBe("T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb");
    expect(tonZeroFriendly).toEqual(["EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c", "UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ"]);
  });

  it("getQuote: EVM 0x0…0, Tron T9yD14…, TON 0:000…0 in raw and user-friendly spellings — before any RPC read", async () => {
    const cases: [Kind, QuoteParams, string][] = [
      ["oft", OFT, ZERO_EVM],
      ["oft", {...OFT, sourceChain: "eip155:1", sourceToken: "USDT", destChain: "eip155:42161", destToken: ARB.token}, ZERO_EVM],
      ["mesh", MESH_TRON, USDT0_MESH_PLACEHOLDER.tron],
      ["mesh", MESH_TON, USDT0_MESH_PLACEHOLDER.ton],
      ["mesh", MESH_TON, tonZeroFriendly[0]!],
      ["mesh", MESH_TON, tonZeroFriendly[1]!],
    ];
    for (const [kind, base, zero] of cases) {
      for (const dry of [false, true, undefined]) {
        const params = dry === undefined ? dryOf({...base, destAddress: zero}, {}, undefined) : {...base, destAddress: zero, dry};
        const {q, reasons, calls} = await quoteOf(kind, params);
        expect([zero, dry, q, reasons]).toEqual([zero, dry, null, [ZERO]]);
        expect(calls.filter((u) => u.startsWith("http://rpc."))).toEqual([]);
      }
      // Without a refund address too: the zero recipient is named, so it is refused, not priced.
      expect((await quoteOf(kind, dryOf({...base, destAddress: zero}, {refund: true}))).reasons).toEqual([ZERO]);
    }
  });

  it("negatives: accounts next to zero, and burn addresses that are not the zero account, are quoted", async () => {
    const one = new Uint8Array(20); one[19] = 1;
    const tonOne = new Uint8Array(32); tonOne[31] = 1;
    for (const [kind, base, near] of [
      ["oft", OFT, "0x0000000000000000000000000000000000000001"],
      ["oft", OFT, "0x000000000000000000000000000000000000dEaD"],
      ["mesh", MESH_TRON, tronAddressOf(one)],
      ["mesh", MESH_TON, `0:${"00".repeat(31)}01`],
      ["mesh", MESH_TON, friendly(0x51, tonOne)],
    ] as const) {
      const {q, reasons} = await quoteOf(kind, {...base, destAddress: near});
      expect([near, reasons]).toEqual([near, []]);
      expect(q!.txRequest!.data).toMatch(/^0x/);
      expect(usdt0VerifyQuote({...base, destAddress: near}, q!)).toBeNull();
    }
  });

  it("usdt0VerifyQuote: a request naming the zero account is refused before its send is read", async () => {
    for (const [kind, live, zero] of [["oft", OFT, ZERO_EVM], ["mesh", MESH_TRON, USDT0_MESH_PLACEHOLDER.tron], ["mesh", MESH_TON, USDT0_MESH_PLACEHOLDER.ton], ["mesh", MESH_TON, tonZeroFriendly[1]!]] as const) {
      const real = (await quoteOf(kind, live)).q!;
      const toZero = resend(real, (sp) => { sp.to = ZERO_B32; });
      for (const params of [{...live, destAddress: zero}, {...live, destAddress: zero, dry: true}, dryOf({...live, destAddress: zero}, {refund: true})]) {
        expect([zero, usdt0VerifyQuote(params, toZero)]).toEqual([zero, ZERO]);
        expect([zero, usdt0VerifyQuote(params, real)]).toEqual([zero, ZERO]);
      }
    }
  });

  it("preflightDeposit: a quote that seals the zero account as its recipient is refused before any RPC read", async () => {
    const cases: [Kind, QuoteParams, Record<string, string>][] = [
      ["oft", OFT, {recipient: ZERO_EVM}],
      ["mesh", MESH_TRON, {recipient: USDT0_MESH_PLACEHOLDER.tron, recipientBytes32: ZERO_B32}],
      ["mesh", MESH_TON, {recipient: USDT0_MESH_PLACEHOLDER.ton, recipientBytes32: ZERO_B32}],
    ];
    for (const [kind, live, sealed] of cases) {
      const {p, calls} = providerFor(kind);
      const real = (await p.getQuote(live))!;
      const tx = await p.buildDeposit(real);
      const before = calls.length;
      await expect(p.preflightDeposit!({...real, providerData: {...real.providerData, ...sealed}}, tx)).rejects.toThrow(`usdt0: ${ZERO}`);
      expect(calls.length).toBe(before);
    }
  });
});

describe("behind remoteProvider, the engine and the router", () => {
  /** The real provider behind the real swap2 handler; `tamper` rewrites the quote the backend answers. */
  function backend(provider: CrossChainProvider, tamper?: (q: Quote) => Quote): typeof fetch {
    const handle = createSwap2Handler<string>({providers: [provider], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
    return (async (url: string, init: RequestInit) => {
      const action = String(url).split("/").pop()!;
      const res = await handle(action, JSON.parse(String(init.body)), "alice");
      const body = tamper && action === "quote" && res.status === 200 ? tamper(res.body as Quote) : res.body;
      return new Response(JSON.stringify(body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
  }
  const stub = (fetchImpl: typeof fetch) => remoteProvider({name: "usdt0", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, ...usdt0Pins});
  /** The message a promise rejects with. */
  const failure = (p: Promise<unknown>) => p.then(() => "resolved", (e: unknown) => (e instanceof Error ? e.message : String(e)));

  it("a backend that answers a dry request with the placeholder's send is refused on the device", async () => {
    for (const [kind, live] of [["oft", OFT], ["mesh", MESH_TRON]] as const) {
      // An older or compromised backend: the price-only quote with the stand-in's send attached again.
      const real = (await quoteOf(kind, live)).q!;
      const standIn = resend(real, (sp, r) => { sp.to = kind === "oft" ? pad(VITALIK, {size: 32}) : ZERO_B32; r.refund = VITALIK; }).txRequest!;
      const evil = stub(backend(providerFor(kind).p, (q) => ({...q, txRequest: standIn})));
      await expect(evil.getQuote(dryOf(live, {dest: true}))).rejects.toThrow(`usdt0: the quote fails this app's own check — ${CARRIES("recipient")}`);
    }
  });

  it("the real server hands out the price only; the pins accept it, and the server will neither build nor preflight it", async () => {
    for (const [kind, live] of [["oft", OFT], ["mesh", MESH_TON]] as const) {
      const s = stub(backend(providerFor(kind).p));
      const params = dryOf(live, {dest: true, refund: true});
      const q = (await s.getQuote(params))!;
      expect(q.txRequest).toBeUndefined();
      expect(q.providerData!.placeholder).toBe("recipient");
      expect(remotePinRefusal(s, q, params.sourceChain)).toBeNull();
      const built = await failure(s.buildDeposit(q));
      expect([built.startsWith("swap2-remote usdt0/build: 422 "), built.includes(BUILD("recipient"))]).toEqual([true, true]);
      const real = (await quoteOf(kind, live)).q!;
      const tx = await providerFor(kind).p.buildDeposit(real);
      const pre = await failure(s.preflightDeposit!(q, tx));
      expect([pre.startsWith("swap2-remote usdt0/preflight: 422 "), pre.includes(PREFLIGHT("recipient"))]).toEqual([true, true]);
    }
  });

  it("the engine: quoteSwap2 without a recipient still prices the route; swap2 re-quotes for the account and sends", async () => {
    const sent: Array<{to: string; data?: string; value?: bigint}> = [];
    const account = {
      getAddress: async () => SENDER, getChainId: async () => 42161, getAllowance: async () => 0n, waitForTransaction: async () => {},
      sendTransaction: async (tx: {to: string; data?: string; value?: bigint}) => { sent.push(tx); return {hash: `0x${String(sent.length).padStart(64, "0")}`}; },
    };
    const mesh = meshMake();
    const proto = new Usdt0Swap2Protocol(account as never, {fromChain: "eip155:42161", rpcUrls: MESH_RPC, fetchImpl: mesh.fetchImpl, scanUrl: "https://scan.test", tonApiUrl: "https://ton.test", skipAccountChainCheck: true} as never);
    const req = {fromToken: "USDT0", toToken: "USDT", toChain: "ton:-239", fromTokenAmount: 10_000_000n};
    const priced = await proto.quoteSwap2(req as never);
    expect(priced).toMatchObject({fromTokenAmount: 10_000_000n, toTokenAmount: 9_997_000n, toTokenAmountMin: 9_997_000n});
    await proto.swap2({...req, recipient: TON_TO, minAmountOut: 9_997_000n} as never);
    // The exact approval to the mesh OFT, then the send to the account's recipient with the sealed fee.
    expect(sent.map((t) => [t.to.toLowerCase(), t.value ?? 0n])).toEqual([[MARB.token.toLowerCase(), 0n], [MARB.oft.toLowerCase(), sealedOf(FEE_TON)]]);
    const [sp, , refund] = decodeFunctionData({abi: MESH_ABI, data: sent[1]!.data as Hex}).args as unknown as [{to: string}, unknown, string];
    expect([sp.to, refund]).toEqual(["0x10b245cca0e225c1065641aa8399f46c350698b324c4e48990a19d9030232ace", SENDER]);
  });

  it("the router: the price-only quote is a dry route like any other; a screen that needs an executable answer drops it", async () => {
    const router = new CrossChainRouter([oftMake().p]);
    const params = dryOf(OFT, {dest: true, refund: true});
    const best = await router.getBestQuote(params);
    expect(best).toMatchObject({provider: "usdt0", providerData: {placeholder: "recipient"}});
    expect(best!.txRequest).toBeUndefined();
    expect(await router.getBestQuote(params, {requireImmediateExecution: true})).toBeNull();
    // Named addresses: the executable quote, with the LayerZero fee as txRequest.nativeFee.
    expect((await router.getBestQuote(OFT, {requireImmediateExecution: true}))?.txRequest?.nativeFee).toBe(SEALED.toString());
  });
});

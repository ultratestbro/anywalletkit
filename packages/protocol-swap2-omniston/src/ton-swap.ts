import "./buffer-global.js";
import {Buffer} from "buffer";
import {Address, Cell, type Slice} from "@ton/core";

/**
 * TON same-chain swap message decoder (scan F11).
 *
 * `tonBuildSwap` returns the body of the one message the trader's wallet
 * signs. The provider's structural checks bind the amount, the attached TON
 * and the contract the message pays into; this module opens the DEX call the
 * body carries and binds what those checks cannot see: who receives the
 * output, where refunds and excesses go, and the on-chain minimum output.
 *
 * Every layout below was decoded from real Omniston builds (fixtures
 * `tests/fixtures/live-ton-swaps-2026-10-22.json`) and cross-checked against
 * the protocols' own SDKs; anything else is refused by name:
 *
 *   STON.fi v2   jetton_transfer → router, forward swap#6664de2a; native input
 *                as pTON v2 ton_transfer#01f3835d to the router's pTON wallet;
 *                multi-hop = cross swap: a hop's receiver is the next router
 *                and its custom payload is the next swap#6664de2a.
 *   STON.fi v1   jetton_transfer → router, forward swap#25938561; native input
 *                as a jetton_transfer to the router's pTON v1 wallet whose
 *                destination is the router (STON.fi SDK v1 shape).
 *   DeDust v1    jetton_transfer → jetton vault, forward swap#e3a0d482; native
 *                vault swap#ea06185d. SwapStep + ^SwapParams.
 *   DeDust CPMM v2  native: pay_native#a5a7cbf8 to the pool; jetton:
 *                jetton_transfer → pool, forward pay_jetton#cbc33949. Payment
 *                payload swap#c442500f + extended payout config.
 *
 * The decoder is pure (no network). Facts that need the chain — that an ask
 * wallet is the router's wallet of the quoted output, that a pool trades the
 * quoted pair, that a pTON wallet belongs to the router — are returned as
 * `legs` for the `validateTonSwapLeg` hook (`createOmnistonTonValidators`).
 */

export const TON_JETTON_TRANSFER_OP = 0x0f8a7ea5;
const PTON_V2_TON_TRANSFER_OP = 0x01f3835d;
const STONFI_V2_SWAP_OP = 0x6664de2a;
const STONFI_V1_SWAP_OP = 0x25938561;
const DEDUST_V1_NATIVE_SWAP_OP = 0xea06185d;
const DEDUST_V1_JETTON_SWAP_OP = 0xe3a0d482;
const DEDUST_V2_PAY_NATIVE_OP = 0xa5a7cbf8;
const DEDUST_V2_PAY_JETTON_OP = 0xcbc33949;
const DEDUST_V2_SWAP_OP = 0xc442500f;

/** Omniston's `SwapChunk.protocol` names and the layout each one builds. */
export const TON_SWAP_PROTOCOL_LAYOUTS: Readonly<Record<string, "stonfi-v1" | "stonfi-v2" | "dedust-v1" | "dedust-v2">> = {
  StonFiV1: "stonfi-v1",
  StonFiV2: "stonfi-v2",
  DeDust: "dedust-v1",
  DeDustCPMMV2: "dedust-v2",
};

/** A chain fact the payload depends on; checked by `validateTonSwapLeg`. A
 *  jetton is named by its master address; `null` is native GRAM. */
export type TonSwapLeg =
  | {
      kind: "stonfi-router";
      version: 1 | 2;
      /** The router that executes this hop; null = the owner of `proxyTonWallet`. */
      router: string | null;
      /** Native input: the router's proxy-TON wallet the message pays into. */
      proxyTonWallet?: string;
      /** The router's wallet the hop asks for — must be the router's wallet of `outputJetton`
       *  (of a proxy-TON master when the output is native). */
      askWallet: string;
      inputJetton: string | null;
      outputJetton: string | null;
    }
  | {
      kind: "dedust-pool";
      version: 1 | 2;
      pool: string;
      inputJetton: string | null;
      outputJetton: string | null;
    };

export interface TonSwapCheckInput {
  /** The built message's body (BoC hex) and destination. */
  payloadHex: string;
  targetAddress: string;
  /** Value attached to the message, nanoTON. */
  sendAmount: bigint;
  /** The trader's wallet (signs; refunds and excesses return to it). */
  trader: string;
  /** Where the output must land. */
  dest: string;
  /** Quote fields the body must honour. */
  inputUnits: string;
  minOutputAmount: string;
  inputJetton: string | null;
  outputJetton: string | null;
  steps: readonly {protocol: string; inputJetton: string | null | undefined; outputJetton: string | null | undefined}[];
  /** The integrator the quote was requested with: the only referral a body may name. */
  integratorAddress?: string | null;
}

export interface TonSwapCheckResult {
  layout: "stonfi-v1" | "stonfi-v2" | "dedust-v1" | "dedust-v2";
  /** On-chain minimum of the final hop. */
  minOut: bigint;
  legs: TonSwapLeg[];
}

/** A refusal with a stable, loggable reason code (never carries secrets). */
export class TonSwapPayloadError extends Error {
  constructor(readonly reason: string, detail?: string) {
    super(`omniston: ton-swap-payload ${reason}${detail ? ` (${detail})` : ""}`);
    this.name = "TonSwapPayloadError";
  }
}

const refuse = (reason: string, detail?: string): never => {
  throw new TonSwapPayloadError(reason, detail);
};

function sameAddr(a: Address | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  try {
    return a.equals(Address.parse(b));
  } catch {
    return false;
  }
}

function end(s: Slice, where: string): void {
  if (s.remainingBits !== 0 || s.remainingRefs !== 0) refuse("unknown-layout", `${where}: ${s.remainingBits} bits / ${s.remainingRefs} refs left over`);
}

/** Either Cell ^Cell forward payload: the rest of this slice or one ref. */
function eitherRef(s: Slice): Slice {
  return s.loadBit() ? s.loadRef().beginParse() : s;
}

function readAddress(s: Slice): Address | null {
  const a = s.loadAddressAny();
  if (a === null) return null;
  if (!(a instanceof Address)) refuse("unknown-layout", "external address");
  return a as Address;
}

/** addr_none means "the sender" (DeDust) — the trader's wallet here. */
function isTraderOrNone(a: Address | null, trader: string): boolean {
  return a === null || sameAddr(a, trader);
}

/** Receiver of the output: exactly the destination, or addr_none ("the sender")
 *  only when the destination IS the trader. */
function receiverOk(a: Address | null, dest: string, trader: string): boolean {
  if (a === null) {
    try {
      return Address.parse(dest).equals(Address.parse(trader));
    } catch {
      return false;
    }
  }
  return sameAddr(a, dest);
}

function referralOk(address: Address | null, fee: number | null, integrator: string | null | undefined): boolean {
  if (address === null) return true;
  if (fee === 0) return true;
  return !!integrator && sameAddr(address, integrator);
}

interface StonFiV2Hop {
  askWallet: Address;
  minOut: bigint;
  receiver: Address | null;
  next: Slice | null;
}

/** STON.fi v2 swap body; follows cross-swap custom payloads. */
function decodeStonFiV2(s: Slice, ctx: TonSwapCheckInput): StonFiV2Hop[] {
  const hops: StonFiV2Hop[] = [];
  let cur: Slice | null = s;
  for (let depth = 0; cur; depth++) {
    if (depth >= 4) refuse("unsupported-ton-route", "STON.fi v2 cross-swap deeper than 4 hops");
    if (cur.loadUint(32) !== STONFI_V2_SWAP_OP) refuse("unknown-layout", `STON.fi v2 hop ${depth} is not swap#6664de2a`);
    const askWallet = readAddress(cur);
    const refund = readAddress(cur);
    const excess = readAddress(cur);
    cur.loadUintBig(64); // tx deadline
    const body = cur.loadRef().beginParse();
    end(cur, "STON.fi v2 swap");
    const minOut = body.loadCoins();
    const receiver = readAddress(body);
    const fwdGas = body.loadCoins();
    const custom = body.loadMaybeRef();
    body.loadCoins(); // refund forward gas
    const refundPayload = body.loadMaybeRef();
    const refFee = body.loadUint(16);
    const refAddress = readAddress(body);
    end(body, "STON.fi v2 cross-swap body");
    if (!askWallet) refuse("unknown-layout", "STON.fi v2 swap without an ask wallet");
    if (!sameAddr(refund, ctx.trader)) refuse("refund-not-trader", `STON.fi v2 hop ${depth}`);
    if (!sameAddr(excess, ctx.trader)) refuse("excess-not-trader", `STON.fi v2 hop ${depth}`);
    if (refundPayload) refuse("unknown-layout", "STON.fi v2 refund payload");
    if (!referralOk(refAddress, refFee, ctx.integratorAddress)) refuse("referral", `STON.fi v2 hop ${depth}`);
    if (custom && fwdGas === 0n) refuse("unknown-layout", "STON.fi v2 custom payload without forward gas");
    hops.push({askWallet: askWallet!, minOut, receiver, next: custom ? custom.beginParse() : null});
    cur = custom ? custom.beginParse() : null;
  }
  return hops;
}

interface DeDustV1Swap {
  pool: Address;
  limit: bigint;
  recipient: Address | null;
  referral: Address | null;
}

/** DeDust v1 SwapStep (inline) + ^SwapParams. */
function decodeDeDustV1(s: Slice): DeDustV1Swap {
  const pool = readAddress(s);
  if (!pool) refuse("unknown-layout", "DeDust v1 swap without a pool");
  if (s.loadUint(1) !== 0) refuse("unknown-layout", "DeDust v1 swap kind is not given_in");
  const limit = s.loadCoins();
  if (s.loadMaybeRef()) refuse("unsupported-ton-route", "DeDust v1 multi-hop (next step)");
  const params = s.loadRef().beginParse();
  end(s, "DeDust v1 swap step");
  params.loadUint(32); // deadline
  const recipient = readAddress(params);
  const referral = readAddress(params);
  params.loadMaybeRef(); // fulfill payload — delivered to the recipient with the output
  params.loadMaybeRef(); // reject payload — delivered back to the sender with the refund
  end(params, "DeDust v1 swap params");
  return {pool: pool!, limit, recipient, referral};
}

interface DeDustV2Swap {
  minOut: bigint;
  fulfill: Address | null;
  reject: Address | null;
  excessesTo: Address | null;
}

/** DeDust CPMM v2 payment payload (swap#c442500f) + extended payout config. */
function decodeDeDustV2(payment: Slice, payout: Slice): DeDustV2Swap {
  if (payment.loadUint(32) !== DEDUST_V2_SWAP_OP) refuse("unknown-layout", "DeDust CPMM v2 payment payload is not swap#c442500f");
  const minOut = payment.loadCoins();
  payment.loadUint(40); // deadline
  if (payment.loadMaybeRef()) refuse("unsupported-ton-route", "DeDust CPMM v2 multi-hop (next step)");
  // Partner / referrer fee configs are not part of an Omniston quote.
  if (payment.loadBit()) refuse("referral", "DeDust CPMM v2 partner config");
  if (payment.loadBit()) refuse("referral", "DeDust CPMM v2 referrer config");
  end(payment, "DeDust CPMM v2 swap payload");
  const options = (): Address | null => {
    const destination = readAddress(payout);
    payout.loadCoins(); // extra gas — bounded by the message value
    payout.loadMaybeRef(); // payload delivered with the payout (to the trader / destination)
    payout.loadBit(); // wrap payload
    return destination;
  };
  const fulfill = options();
  const reject = options();
  const excessesTo = readAddress(payout);
  end(payout, "DeDust CPMM v2 payout config");
  return {minOut, fulfill, reject, excessesTo};
}

/**
 * Decode and check a built TON same-chain swap message. Throws
 * `TonSwapPayloadError` with a reason code on the first violated rule; returns
 * the chain facts (`legs`) still to be confirmed by `validateTonSwapLeg`.
 *
 * Rules (all protocols): one route of single-protocol steps; the body's
 * layout is the one the quoted protocol builds; the DEX call moves exactly the
 * quoted input; the final receiver is the destination; refunds / excesses go
 * to the trader; the final on-chain minimum is ≥ the quote's minOutputAmount;
 * no referral other than the configured integrator; no trailing data.
 */
export function checkTonSwapPayload(ctx: TonSwapCheckInput): TonSwapCheckResult {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(ctx.payloadHex)) refuse("malformed", "payload hex");
  const roots = Cell.fromBoc(Buffer.from(ctx.payloadHex, "hex"));
  if (roots.length !== 1) refuse("malformed", "payload must have one root");
  const steps = ctx.steps;
  if (steps.length === 0) refuse("unsupported-ton-route", "no route steps");
  const layouts = steps.map((step) => TON_SWAP_PROTOCOL_LAYOUTS[step.protocol] ?? refuse("unsupported-ton-route", `protocol ${step.protocol}`));
  const layout = layouts[0]!;
  if (layouts.some((l) => l !== layout)) refuse("unsupported-ton-route", `mixed protocols ${steps.map((s) => s.protocol).join("+")}`);
  if (steps.length > 1 && layout !== "stonfi-v2") refuse("unsupported-ton-route", `${steps.length}-step ${steps[0]!.protocol} route`);
  // Steps must chain from the quoted input to the quoted output.
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const wantIn = i === 0 ? ctx.inputJetton : steps[i - 1]!.outputJetton;
    const wantOut = i === steps.length - 1 ? ctx.outputJetton : step.outputJetton;
    if (step.inputJetton === undefined || step.outputJetton === undefined) refuse("unsupported-ton-route", `step ${i} without assets`);
    if (!sameJetton(step.inputJetton!, wantIn ?? null) || !sameJetton(step.outputJetton!, wantOut ?? null)) refuse("unsupported-ton-route", `step ${i} assets do not chain`);
  }

  const input = BigInt(ctx.inputUnits);
  const quotedMin = BigInt(ctx.minOutputAmount);
  const nativeInput = ctx.inputJetton === null;
  const s = roots[0]!.beginParse();
  const op = s.loadUint(32);
  const legs: TonSwapLeg[] = [];
  const minOk = (minOut: bigint) => {
    if (minOut < quotedMin) refuse(minOut === 0n ? "min-out-zero" : "min-out-below-quote", `${minOut} < ${quotedMin}`);
  };

  // Jetton transfer header: from the trader's jetton wallet (jetton input) or
  // to the router's pTON v1 wallet (STON.fi v1 native input).
  let transfer: null | {destination: Address; forward: Slice; inline: boolean} = null;
  if (op === TON_JETTON_TRANSFER_OP) {
    s.loadUintBig(64);
    const amount = s.loadCoins();
    const destination = readAddress(s);
    const response = readAddress(s);
    if (s.loadMaybeRef()) refuse("unknown-layout", "jetton transfer custom payload");
    s.loadCoins(); // forward TON — bounded by the provider's structural checks
    const inline = !s.loadBit();
    const forward = inline ? s : s.loadRef().beginParse();
    if (amount !== input) refuse("amount-mismatch", "jetton transfer amount");
    if (!destination) refuse("unknown-layout", "jetton transfer without a destination");
    if (!sameAddr(response, ctx.trader)) refuse("excess-not-trader", "jetton transfer response destination");
    transfer = {destination: destination!, forward, inline};
  }

  let minOut: bigint;
  if (layout === "stonfi-v2") {
    let hopsSlice: Slice;
    let router: string | null;
    let proxyTonWallet: string | undefined;
    if (nativeInput) {
      if (op !== PTON_V2_TON_TRANSFER_OP) refuse("unknown-layout", `native STON.fi v2 input op 0x${op.toString(16)}`);
      s.loadUintBig(64);
      const tonAmount = s.loadCoins();
      const refund = readAddress(s);
      hopsSlice = eitherRef(s);
      end(s, "pTON v2 ton_transfer");
      if (tonAmount !== input) refuse("amount-mismatch", "pTON v2 ton_amount");
      if (!sameAddr(refund, ctx.trader)) refuse("refund-not-trader", "pTON v2 refund address");
      router = null;
      proxyTonWallet = ctx.targetAddress;
    } else {
      if (!transfer) refuse("unknown-layout", `jetton-input STON.fi v2 op 0x${op.toString(16)}`);
      if (!transfer!.inline) end(s, "jetton transfer");
      hopsSlice = transfer!.forward;
      router = transfer!.destination.toString();
    }
    const hops = decodeStonFiV2(hopsSlice, ctx);
    if (hops.length !== steps.length) refuse("unsupported-ton-route", `${hops.length} STON.fi v2 hops for ${steps.length} quoted steps`);
    hops.forEach((hop, i) => {
      const last = i === hops.length - 1;
      if (last) {
        if (!receiverOk(hop.receiver, ctx.dest, ctx.trader) || hop.receiver === null) refuse("receiver-not-destination", `STON.fi v2 hop ${i}`);
        if (hop.next) refuse("unknown-layout", "STON.fi v2 final hop carries a custom payload");
      } else if (!hop.receiver) refuse("unknown-layout", `STON.fi v2 hop ${i} without a receiver`);
      legs.push({
        kind: "stonfi-router",
        version: 2,
        router: i === 0 ? router : hops[i - 1]!.receiver!.toString(),
        ...(i === 0 && proxyTonWallet ? {proxyTonWallet} : {}),
        askWallet: hop.askWallet.toString(),
        inputJetton: steps[i]!.inputJetton ?? null,
        outputJetton: steps[i]!.outputJetton ?? null,
      });
    });
    minOut = hops[hops.length - 1]!.minOut;
  } else if (layout === "stonfi-v1") {
    if (!transfer) refuse("unknown-layout", `STON.fi v1 op 0x${op.toString(16)}`);
    if (!transfer!.inline) end(s, "jetton transfer");
    const f = transfer!.forward;
    if (f.loadUint(32) !== STONFI_V1_SWAP_OP) refuse("unknown-layout", "STON.fi v1 forward payload is not swap#25938561");
    const askWallet = readAddress(f);
    minOut = f.loadCoins();
    const to = readAddress(f);
    const referral = f.loadBit() ? readAddress(f) : null;
    end(f, "STON.fi v1 swap");
    if (!askWallet) refuse("unknown-layout", "STON.fi v1 swap without an ask wallet");
    if (!to || !sameAddr(to, ctx.dest)) refuse("receiver-not-destination", "STON.fi v1 to_address");
    if (!referralOk(referral, null, ctx.integratorAddress)) refuse("referral", "STON.fi v1");
    // Native input: the message pays the router's pTON v1 wallet, the transfer
    // names the router; jetton input: the transfer goes straight to the router.
    legs.push({
      kind: "stonfi-router",
      version: 1,
      router: transfer!.destination.toString(),
      ...(nativeInput ? {proxyTonWallet: ctx.targetAddress} : {}),
      askWallet: askWallet!.toString(),
      inputJetton: ctx.inputJetton,
      outputJetton: ctx.outputJetton,
    });
  } else if (layout === "dedust-v1") {
    let swap: DeDustV1Swap;
    if (nativeInput) {
      if (op !== DEDUST_V1_NATIVE_SWAP_OP) refuse("unknown-layout", `native DeDust v1 input op 0x${op.toString(16)}`);
      s.loadUintBig(64);
      const amount = s.loadCoins();
      if (amount !== input) refuse("amount-mismatch", "DeDust v1 native vault amount");
      swap = decodeDeDustV1(s);
    } else {
      if (!transfer) refuse("unknown-layout", `jetton-input DeDust v1 op 0x${op.toString(16)}`);
      if (!transfer!.inline) end(s, "jetton transfer");
      const f = transfer!.forward;
      if (f.loadUint(32) !== DEDUST_V1_JETTON_SWAP_OP) refuse("unknown-layout", "DeDust v1 forward payload is not swap#e3a0d482");
      swap = decodeDeDustV1(f);
    }
    if (!receiverOk(swap.recipient, ctx.dest, ctx.trader)) refuse("receiver-not-destination", "DeDust v1 recipient");
    if (!referralOk(swap.referral, null, ctx.integratorAddress)) refuse("referral", "DeDust v1");
    minOut = swap.limit;
    legs.push({kind: "dedust-pool", version: 1, pool: swap.pool.toString(), inputJetton: ctx.inputJetton, outputJetton: ctx.outputJetton});
  } else {
    let swap: DeDustV2Swap;
    let pool: string;
    if (nativeInput) {
      if (op !== DEDUST_V2_PAY_NATIVE_OP) refuse("unknown-layout", `native DeDust CPMM v2 input op 0x${op.toString(16)}`);
      s.loadUintBig(64);
      const amount = s.loadCoins();
      const payment = s.loadRef().beginParse();
      const payout = s.loadRef().beginParse();
      end(s, "DeDust CPMM v2 pay_native");
      if (amount !== input) refuse("amount-mismatch", "DeDust CPMM v2 pay_native amount");
      swap = decodeDeDustV2(payment, payout);
      pool = ctx.targetAddress;
    } else {
      if (!transfer) refuse("unknown-layout", `jetton-input DeDust CPMM v2 op 0x${op.toString(16)}`);
      if (!transfer!.inline) end(s, "jetton transfer");
      const f = transfer!.forward;
      if (f.loadUint(32) !== DEDUST_V2_PAY_JETTON_OP) refuse("unknown-layout", "DeDust CPMM v2 forward payload is not pay_jetton#cbc33949");
      const payment = f.loadRef().beginParse();
      const payout = f.loadRef().beginParse();
      end(f, "DeDust CPMM v2 pay_jetton");
      swap = decodeDeDustV2(payment, payout);
      pool = transfer!.destination.toString();
    }
    if (!receiverOk(swap.fulfill, ctx.dest, ctx.trader)) refuse("receiver-not-destination", "DeDust CPMM v2 fulfill destination");
    if (!isTraderOrNone(swap.reject, ctx.trader)) refuse("refund-not-trader", "DeDust CPMM v2 reject destination");
    if (!isTraderOrNone(swap.excessesTo, ctx.trader)) refuse("excess-not-trader", "DeDust CPMM v2 excesses");
    minOut = swap.minOut;
    legs.push({kind: "dedust-pool", version: 2, pool, inputJetton: ctx.inputJetton, outputJetton: ctx.outputJetton});
  }
  minOk(minOut);
  return {layout, minOut, legs};
}

function sameJetton(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  try {
    return Address.parse(a).equals(Address.parse(b));
  } catch {
    return false;
  }
}

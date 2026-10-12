/**
 * Transaction preview for EVM: what a call (or an approve → call sequence)
 * will do before the key signs it.
 *
 *  - decode: approvals (ERC-20 approve / increaseAllowance, Permit2 approve,
 *    setApprovalForAll), token transfers, and the target's label when the
 *    caller lists it as known (a provider's trusted contracts).
 *  - simulate: eth_simulateV1 with transfer tracing → the sender's balance
 *    changes per token; where a node lacks it, eth_call says pass / revert
 *    for a single call and the sequence is reported as not simulated.
 *  - checks: named outcomes (codes, not prose) the app turns into its verdict.
 *
 * Nothing here signs or sends. The RPC is the caller's.
 */
import {decodeFunctionData, hexToString, isHex, parseAbi, type Hex} from "viem";

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export interface PreviewCall {
  to: string;
  data?: string;
  value?: bigint;
}

export interface PreviewInput {
  chainId: number;
  from: string;
  /** Executed in order in one simulated block (approve first, then the call). */
  calls: PreviewCall[];
  rpc: Rpc;
  /** Addresses that are "you" (all of the user's accounts, lower or mixed case). */
  own: string[];
  /** Known contracts: address → label (e.g. a provider's trusted targets). */
  known?: Record<string, string>;
  /** Where the funds are meant to arrive (a swap's destination address). */
  expectedRecipient?: string;
  /** Amount the flow needs approved (base units); larger approvals are flagged. */
  expectedApproval?: bigint;
  /** Native coin symbol and decimals for balance changes (default ETH / 18). */
  native?: {symbol: string; decimals: number};
  /**
   * State overrides applied to the simulated block (eth_simulateV1
   * `stateOverrides`, eth_call's third parameter): e.g. fund the sender with a
   * native `balance` or an ERC-20 balance via `stateDiff` on the token's
   * balance slot, to prove a flow a not-yet-funded account will sign.
   */
  stateOverrides?: Record<string, {balance?: bigint; nonce?: number; code?: string; stateDiff?: Record<string, string>}>;
}

function overridesJson(o: PreviewInput["stateOverrides"]): Record<string, Record<string, unknown>> | undefined {
  if (!o) return undefined;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [addr, v] of Object.entries(o)) {
    out[addr] = {
      ...(v.balance !== undefined ? {balance: hex(v.balance)} : {}),
      ...(v.nonce !== undefined ? {nonce: hex(BigInt(v.nonce))} : {}),
      ...(v.code !== undefined ? {code: v.code} : {}),
      ...(v.stateDiff ? {stateDiff: v.stateDiff} : {}),
    };
  }
  return out;
}

export interface Approval {
  token: string;
  spender: string;
  spenderLabel: string | null;
  /** null = unlimited (≥ 2^255) or an operator approval for all. */
  amount: bigint | null;
  kind: "erc20" | "permit2" | "operator";
}

export interface DecodedCall {
  to: string;
  label: string | null;
  selector: string | null;
  method: string;
  value: bigint;
  approval?: Approval;
  transfer?: {token: string; to: string; amount: bigint};
}

export interface BalanceChange {
  /** Token address, or "native". */
  token: string;
  symbol: string | null;
  decimals: number | null;
  /** Signed, base units, for the sender. */
  delta: bigint;
}

export type Simulation =
  | {status: "ok"; changes: BalanceChange[]; gasUsed: bigint[]}
  | {status: "reverted"; callIndex: number; reason: string}
  | {status: "unavailable"; reason: string};

export type CheckCode =
  | "contract-known" | "contract-unknown"
  | "simulation-ok" | "simulation-reverted" | "simulation-unavailable"
  | "recipient-own" | "recipient-foreign"
  | "approval-exact" | "approval-excess" | "approval-unlimited" | "approval-unknown-spender"
  | "native-value";

export interface Check {
  code: CheckCode;
  status: "ok" | "warn" | "unknown";
  /** Values the app needs to word it (labels, addresses, amounts). */
  detail?: Record<string, string>;
}

export interface TxPreview {
  calls: DecodedCall[];
  simulation: Simulation;
  checks: Check[];
}

const UNLIMITED = 1n << 255n;
const NATIVE_TRACE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ABI = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 addedValue)",
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function setApprovalForAll(address operator, bool approved)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";

const lc = (a: string) => a.toLowerCase();

export function decodeCall(call: PreviewCall, known: Record<string, string> = {}): DecodedCall {
  const to = lc(call.to);
  const label = knownLabel(known, to);
  const value = call.value ?? 0n;
  const data = call.data && call.data !== "0x" ? (call.data as Hex) : null;
  const base: DecodedCall = {to, label, selector: data ? data.slice(0, 10) : null, method: data ? data.slice(0, 10) : "transfer (native)", value};
  if (!data) return base;
  let decoded: {functionName: string; args?: readonly unknown[]};
  try {
    decoded = decodeFunctionData({abi: ABI, data});
  } catch {
    return base;
  }
  const args = decoded.args ?? [];
  const spenderOf = (s: unknown) => lc(String(s));
  switch (decoded.functionName) {
    case "approve": {
      if (args.length === 4) {
        // Permit2's own approve(token, spender, amount, expiration).
        if (to !== PERMIT2) return {...base, method: "approve"};
        const amount = args[2] as bigint;
        const spender = spenderOf(args[1]);
        return {...base, method: "approve (Permit2)", approval: {token: lc(String(args[0])), spender, spenderLabel: knownLabel(known, spender), amount: amount >= (1n << 159n) ? null : amount, kind: "permit2"}};
      }
      const amount = args[1] as bigint;
      const spender = spenderOf(args[0]);
      return {...base, method: "approve", approval: {token: to, spender, spenderLabel: knownLabel(known, spender), amount: amount >= UNLIMITED ? null : amount, kind: "erc20"}};
    }
    case "increaseAllowance": {
      const amount = args[1] as bigint;
      const spender = spenderOf(args[0]);
      return {...base, method: "increaseAllowance", approval: {token: to, spender, spenderLabel: knownLabel(known, spender), amount: amount >= UNLIMITED ? null : amount, kind: "erc20"}};
    }
    case "setApprovalForAll": {
      if (args[1] !== true) return {...base, method: "setApprovalForAll (revoke)"};
      const spender = spenderOf(args[0]);
      return {...base, method: "setApprovalForAll", approval: {token: to, spender, spenderLabel: knownLabel(known, spender), amount: null, kind: "operator"}};
    }
    case "transfer":
      return {...base, method: "transfer", transfer: {token: to, to: lc(String(args[0])), amount: args[1] as bigint}};
    case "transferFrom":
      return {...base, method: "transferFrom", transfer: {token: to, to: lc(String(args[1])), amount: args[2] as bigint}};
    default:
      return base;
  }
}

function knownLabel(known: Record<string, string>, address: string): string | null {
  for (const [k, v] of Object.entries(known)) if (lc(k) === address) return v;
  return null;
}

const hex = (n: bigint) => `0x${n.toString(16)}`;

interface SimCall { status?: string; gasUsed?: string; returnData?: string; error?: {message?: string; data?: string}; logs?: {address: string; topics: string[]; data: string}[] }

/** eth_simulateV1 over the whole sequence; null when the node doesn't serve it. */
async function simulateV1(input: PreviewInput): Promise<Simulation | null> {
  let blocks: {calls?: SimCall[]}[];
  try {
    blocks = (await input.rpc("eth_simulateV1", [{
      blockStateCalls: [{...(input.stateOverrides ? {stateOverrides: overridesJson(input.stateOverrides)} : {}), calls: input.calls.map((c) => ({from: input.from, to: c.to, ...(c.data ? {data: c.data} : {}), value: hex(c.value ?? 0n)}))}],
      traceTransfers: true,
      validation: false,
    }, "latest"])) as {calls?: SimCall[]}[];
  } catch (err) {
    const code = (err as {code?: number}).code;
    const msg = err instanceof Error ? err.message : String(err);
    if (code === -32601 || /not (exist|found|available|supported)|method.*not/i.test(msg)) return null;
    return {status: "unavailable", reason: msg.slice(0, 200)};
  }
  const calls = blocks?.[0]?.calls ?? [];
  if (calls.length !== input.calls.length) return {status: "unavailable", reason: "simulation returned a different number of calls"};
  const failed = calls.findIndex((c) => c.status !== "0x1");
  if (failed >= 0) return {status: "reverted", callIndex: failed, reason: revertReason(calls[failed]!)};

  const me = lc(input.from);
  const deltas = new Map<string, bigint>();
  for (const c of calls) for (const log of c.logs ?? []) {
    if (lc(log.topics[0] ?? "") !== TRANSFER_TOPIC || log.topics.length !== 3) continue; // ERC-721 has 4 topics
    const from = `0x${(log.topics[1] ?? "").slice(26)}`;
    const to = `0x${(log.topics[2] ?? "").slice(26)}`;
    let amount: bigint;
    try {
      amount = BigInt(log.data);
    } catch {
      continue;
    }
    const token = lc(log.address) === NATIVE_TRACE ? "native" : lc(log.address);
    if (from === me) deltas.set(token, (deltas.get(token) ?? 0n) - amount);
    if (to === me) deltas.set(token, (deltas.get(token) ?? 0n) + amount);
  }
  const native = input.native ?? {symbol: "ETH", decimals: 18};
  const changes: BalanceChange[] = [];
  for (const [token, delta] of deltas) {
    if (delta === 0n) continue;
    const meta = token === "native" ? native : await tokenMeta(input.rpc, token);
    changes.push({token, symbol: meta.symbol, decimals: meta.decimals, delta});
  }
  return {status: "ok", changes, gasUsed: calls.map((c) => BigInt(c.gasUsed ?? "0x0"))};
}

function revertReason(c: SimCall): string {
  const data = c.error?.data ?? c.returnData;
  // Error(string): 0x08c379a0 + offset + length + bytes.
  if (data && data.startsWith("0x08c379a0") && data.length >= 138) {
    try {
      const len = Number(BigInt(`0x${data.slice(74, 138)}`));
      const s = hexToString(`0x${data.slice(138, 138 + len * 2)}` as Hex);
      if (s) return s;
    } catch { /* fall through */ }
  }
  return c.error?.message ?? (data && data !== "0x" ? `reverted (${data.slice(0, 10)})` : "reverted");
}

async function tokenMeta(rpc: Rpc, token: string): Promise<{symbol: string | null; decimals: number | null}> {
  const call = (data: string) => rpc("eth_call", [{to: token, data}, "latest"]) as Promise<string>;
  const [sym, dec] = await Promise.all([call("0x95d89b41").catch(() => null), call("0x313ce567").catch(() => null)]);
  let symbol: string | null = null;
  if (sym && isHex(sym) && sym.length >= 130) {
    try {
      const len = Number(BigInt(`0x${sym.slice(66, 130)}`));
      symbol = hexToString(`0x${sym.slice(130, 130 + len * 2)}` as Hex) || null;
    } catch { /* ignore */ }
  } else if (sym && isHex(sym) && sym.length === 66) {
    try {
      symbol = hexToString(sym as Hex).replace(/\0+$/, "") || null; // bytes32 symbols (MKR-style)
    } catch { /* ignore */ }
  }
  let decimals: number | null = null;
  if (dec && isHex(dec) && dec.length > 2) {
    const d = Number(BigInt(dec));
    decimals = d <= 255 ? d : null;
  }
  return {symbol, decimals};
}

/** Single call without eth_simulateV1: does it revert? */
async function callFallback(input: PreviewInput): Promise<Simulation> {
  if (input.calls.length !== 1) return {status: "unavailable", reason: "this network can't simulate a sequence of calls"};
  const c = input.calls[0]!;
  try {
    const overrides = overridesJson(input.stateOverrides);
    await input.rpc("eth_call", [{from: input.from, to: c.to, ...(c.data ? {data: c.data} : {}), value: hex(c.value ?? 0n)}, "latest", ...(overrides ? [overrides] : [])]);
    return {status: "unavailable", reason: "the call passes, but this network can't show balance changes"};
  } catch (err) {
    const data = (err as {data?: string}).data;
    return {status: "reverted", callIndex: 0, reason: revertReason({...(data ? {returnData: data} : {}), error: {message: err instanceof Error ? err.message.slice(0, 200) : String(err)}})};
  }
}

export async function previewEvmTx(input: PreviewInput): Promise<TxPreview> {
  if (!input.calls.length) throw new Error("tx-preview: no calls");
  const known = input.known ?? {};
  const calls = input.calls.map((c) => decodeCall(c, known));
  const simulation = (await simulateV1(input)) ?? (await callFallback(input));
  return {calls, simulation, checks: checksFor(input, calls, simulation)};
}

export function checksFor(input: PreviewInput, calls: DecodedCall[], sim: Simulation): Check[] {
  const own = new Set(input.own.map(lc));
  own.add(lc(input.from));
  const checks: Check[] = [];

  // The contract that does the work: the last call (approvals precede it).
  const main = calls[calls.length - 1]!;
  const target = main.transfer ? null : main;
  if (target && main.selector) {
    checks.push(target.label
      ? {code: "contract-known", status: "ok", detail: {label: target.label, address: target.to}}
      : {code: "contract-unknown", status: "warn", detail: {address: target.to}});
  }

  if (sim.status === "ok") checks.push({code: "simulation-ok", status: "ok"});
  else if (sim.status === "reverted") checks.push({code: "simulation-reverted", status: "warn", detail: {reason: sim.reason, call: String(sim.callIndex)}});
  else checks.push({code: "simulation-unavailable", status: "unknown", detail: {reason: sim.reason}});

  const recipients = new Set<string>();
  for (const c of calls) if (c.transfer) recipients.add(c.transfer.to);
  if (!main.selector && main.value > 0n) recipients.add(main.to);
  if (input.expectedRecipient) recipients.add(lc(input.expectedRecipient));
  for (const r of recipients) {
    checks.push(own.has(r) ? {code: "recipient-own", status: "ok", detail: {address: r}} : {code: "recipient-foreign", status: "warn", detail: {address: r}});
  }

  for (const c of calls) {
    const a = c.approval;
    if (!a) continue;
    const detail: Record<string, string> = {token: a.token, spender: a.spender, ...(a.spenderLabel ? {label: a.spenderLabel} : {}), ...(a.amount !== null ? {amount: a.amount.toString()} : {})};
    if (!a.spenderLabel) checks.push({code: "approval-unknown-spender", status: "warn", detail});
    if (a.amount === null) checks.push({code: "approval-unlimited", status: "warn", detail});
    else if (input.expectedApproval !== undefined && a.amount > input.expectedApproval) checks.push({code: "approval-excess", status: "warn", detail: {...detail, expected: input.expectedApproval.toString()}});
    else checks.push({code: "approval-exact", status: "ok", detail});
  }

  const nativeOut = calls.reduce((s, c) => s + c.value, 0n);
  if (nativeOut > 0n && main.selector) checks.push({code: "native-value", status: "ok", detail: {amount: nativeOut.toString()}});
  return checks;
}

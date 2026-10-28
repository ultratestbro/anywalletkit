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
import {hexToString, isHex, type Hex} from "viem";

/**
 * Any JSON-RPC transport: `(method, params) => result`. Wrap viem, ethers or `fetch` in one line.
 */
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

/** One call to preview: target, calldata and native value. */
export interface PreviewCall {
  to: string;
  data?: string;
  value?: bigint;
}

/**
 * What to preview: the calls (approvals first), who sends them, on which chain, and which addresses
 * and contracts the app already knows.
 */
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

/** An allowance a call grants: ERC-20 `approve`, Permit2, or an operator approval for all. */
export interface Approval {
  token: string;
  spender: string;
  spenderLabel: string | null;
  /** null = unlimited (≥ 2^255) or an operator approval for all. */
  amount: bigint | null;
  kind: "erc20" | "permit2" | "operator";
}

/** One call decoded: method, value, and the approval or token transfer it makes. */
export interface DecodedCall {
  to: string;
  label: string | null;
  selector: string | null;
  method: string;
  value: bigint;
  approval?: Approval;
  transfer?: {token: string; to: string; amount: bigint};
  /** The calldata is not hex bytes: nothing can be said about what it does (a warning, never a plain call). */
  undecodable?: true;
}

/** How one asset's balance of the sender changes when the calls run. */
export interface BalanceChange {
  /** Token address, or "native". */
  token: string;
  symbol: string | null;
  decimals: number | null;
  /** Signed, base units, for the sender. */
  delta: bigint;
  /** Native, or a token the caller lists in `known`. Otherwise `symbol` is whatever the contract claims. */
  verified: boolean;
}

/**
 * The simulation result: balance changes and gas, the call that reverted and why, or why simulation
 * was unavailable.
 */
export type Simulation =
  | {status: "ok"; changes: BalanceChange[]; gasUsed: bigint[]}
  | {status: "reverted"; callIndex: number; reason: string}
  | {status: "unavailable"; reason: string};

/**
 * What a check is about: whether the contract is known, the simulation outcome, who receives, and
 * how large an approval is.
 */
export type CheckCode =
  | "contract-known" | "contract-unknown"
  | "simulation-ok" | "simulation-reverted" | "simulation-unavailable"
  | "recipient-own" | "recipient-foreign"
  | "approval-exact" | "approval-excess" | "approval-unlimited" | "approval-unknown-spender"
  /** A bounded approval with no `expectedApproval` to compare it with: neither "exact" nor "excess" can be said. */
  | "approval-unchecked"
  | "native-value"
  /** Calldata that is not hex bytes: what it grants or moves cannot be read. */
  | "calldata-undecodable";

/** One item for the review screen: a code, a status, and the values to word it with. */
export interface Check {
  code: CheckCode;
  status: "ok" | "warn" | "unknown";
  /** Values the app needs to word it (labels, addresses, amounts). */
  detail?: Record<string, string>;
}

/** Everything a review screen needs: decoded calls, the simulation and the checks. */
export interface TxPreview {
  calls: DecodedCall[];
  simulation: Simulation;
  checks: Check[];
}

/**
 * The smallest allowance treated as unlimited: type(uint128).max, the SDK-wide threshold. Every
 * "infinite approval" sentinel in use (uint256, uint160, uint128 max, 2^255) reaches it.
 */
const UNLIMITED = (1n << 128n) - 1n;
const NATIVE_TRACE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** WETH9 `Deposit(address indexed dst, uint wad)` / `Withdrawal(address indexed src, uint wad)`: wrapping mints
 *  and unwrapping burns without a Transfer log. */
const WETH_DEPOSIT_TOPIC = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";
const WETH_WITHDRAWAL_TOPIC = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";

/**
 * The calls whose arguments name who receives tokens or an allowance, by selector. They are read
 * word by word the way the EVM reads calldata, not with a strict ABI decoder: a token contract
 * built with Solidity below 0.5 zero-pads calldata that is too short and takes any non-zero word
 * as `true`, and a selector may be written in either letter case. A strict decoder threw on those
 * and the approval vanished from the review while the contract still executed it (scan 2026-10-27
 * modules F3, F14, F17).
 */
const SELECTOR = {
  approve: "0x095ea7b3", // approve(address spender, uint256 amount)
  increaseAllowance: "0x39509351", // increaseAllowance(address spender, uint256 addedValue)
  transfer: "0xa9059cbb", // transfer(address to, uint256 amount)
  transferFrom: "0x23b872dd", // transferFrom(address from, address to, uint256 amount)
  setApprovalForAll: "0xa22cb465", // setApprovalForAll(address operator, bool approved)
  permit2Approve: "0x87517c45", // Permit2 approve(address token, address spender, uint160 amount, uint48 expiration)
} as const;

const lc = (a: string) => a.toLowerCase();

/**
 * Decode one call offline: ERC-20 transfer, approve, Permit2, operator approvals and known
 * selectors. Calldata that is not hex bytes is `undecodable` (a warning in {@link checksFor}),
 * never a plain call.
 */
export function decodeCall(call: PreviewCall, known: Record<string, string> = {}): DecodedCall {
  const to = lc(call.to);
  const label = knownLabel(known, to);
  const value = call.value ?? 0n;
  const raw = typeof call.data === "string" && call.data !== "" && call.data.toLowerCase() !== "0x" ? call.data : null;
  if (raw === null) return {to, label, selector: null, method: "transfer (native)", value};
  const data = raw.toLowerCase();
  if (!/^0x([0-9a-f]{2})*$/.test(data)) {
    return {to, label, selector: data.slice(0, 10), method: "undecodable calldata", value, undecodable: true};
  }
  const selector = data.slice(0, 10);
  const base: DecodedCall = {to, label, selector, method: selector, value};
  // Word i of the arguments as the EVM reads it: past the end of the calldata, zeros.
  const word = (i: number) => data.slice(10 + 64 * i, 10 + 64 * (i + 1)).padEnd(64, "0");
  const uint = (i: number) => BigInt(`0x${word(i)}`);
  const address = (i: number) => `0x${word(i).slice(24)}`;
  const cap = (amount: bigint) => (amount >= UNLIMITED ? null : amount);
  switch (selector) {
    case SELECTOR.permit2Approve: {
      // Permit2's own approve(token, spender, amount, expiration), at whatever address the chain's
      // Permit2 lives (zkSync Era's is not the CREATE2 one) — every such call is read as one (F29).
      const spender = address(1);
      return {...base, method: to === PERMIT2 ? "approve (Permit2)" : "approve (Permit2 signature)", approval: {token: address(0), spender, spenderLabel: knownLabel(known, spender), amount: cap(uint(2)), kind: "permit2"}};
    }
    case SELECTOR.approve:
    case SELECTOR.increaseAllowance: {
      const spender = address(0);
      return {...base, method: selector === SELECTOR.approve ? "approve" : "increaseAllowance", approval: {token: to, spender, spenderLabel: knownLabel(known, spender), amount: cap(uint(1)), kind: "erc20"}};
    }
    case SELECTOR.setApprovalForAll: {
      if (uint(1) === 0n) return {...base, method: "setApprovalForAll (revoke)"};
      const spender = address(0);
      return {...base, method: "setApprovalForAll", approval: {token: to, spender, spenderLabel: knownLabel(known, spender), amount: null, kind: "operator"}};
    }
    // ERC-20 transfer/transferFrom are not payable: a call that also sends native
    // value is something else wearing the selector, reviewed as a contract call.
    case SELECTOR.transfer:
      if (value > 0n) return {...base, method: "transfer (with value)"};
      return {...base, method: "transfer", transfer: {token: to, to: address(0), amount: uint(1)}};
    case SELECTOR.transferFrom:
      if (value > 0n) return {...base, method: "transferFrom (with value)"};
      return {...base, method: "transferFrom", transfer: {token: to, to: address(1), amount: uint(2)}};
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

/** JSON-RPC codes for "this node does not serve the method": method not found (EIP-1474), method not supported (EIP-1474 -32004). */
const UNSUPPORTED_CODES = new Set([-32601, -32004]);
const UNSUPPORTED_ERRORS = new Set(["MethodNotFoundRpcError", "MethodNotSupportedRpcError"]);
/** Only the head of a node-controlled message is read: the text can be megabytes (scan F23). Both patterns are linear. */
const TEXT_HEAD = 300;
const UNSUPPORTED_TEXT = /\bnot (?:exist|found|available|supported|whitelisted)\b|\bunsupported method\b/i;
const UNSUPPORTED_BODY_CODE = /"code"\s*:\s*-32(?:601|004)\b/;

/**
 * Did eth_simulateV1 fail because the node does not serve it (→ eth_call fallback)?
 * Structured first — the JSON-RPC code or viem's typed error anywhere on the cause
 * chain (-32601: Avalanche, Hyperliquid, MegaETH, Linea, Arc, Morph, Flare) —, then
 * the JSON body of an HTTP error (403 + -32601: zkSync, Celo, Unichain, Sei, X Layer),
 * then a bounded text match on the first {@link TEXT_HEAD} characters of
 * `details` / `shortMessage` / `message` (Monad: -32000 "`validation: false` is not
 * supported yet"). Never a regex over the whole server-supplied text.
 */
export function simulateUnsupported(err: unknown): boolean {
  const texts: string[] = [];
  let e: unknown = err;
  for (let depth = 0; depth < 8 && typeof e === "object" && e !== null; depth++) {
    const o = e as {code?: unknown; name?: unknown; details?: unknown; shortMessage?: unknown; message?: unknown; cause?: unknown};
    if (typeof o.code === "number" && UNSUPPORTED_CODES.has(o.code)) return true;
    if (typeof o.name === "string" && UNSUPPORTED_ERRORS.has(o.name)) return true;
    for (const t of [o.details, o.shortMessage, o.message]) if (typeof t === "string") texts.push(t.slice(0, TEXT_HEAD));
    e = o.cause;
  }
  if (typeof err === "string") texts.push(err.slice(0, TEXT_HEAD));
  return texts.some((t) => UNSUPPORTED_BODY_CODE.test(t) || UNSUPPORTED_TEXT.test(t));
}

/** eth_simulateV1 over the whole sequence; null when the node doesn't serve it. */
async function simulateV1(input: PreviewInput): Promise<Simulation | null> {
  // The simulated block defaults to parent + 12 s (Ethereum's slot). On fast chains
  // (BSC, Arbitrum, …) that is far past when the tx would land, and routes with
  // short validity windows (e.g. OKX PMM legs inside LI.FI) revert only in the
  // simulation. Pin the parent and place the block 1 s after it.
  let parent: {number?: string; timestamp?: string} | null = null;
  try {
    parent = (await input.rpc("eth_getBlockByNumber", ["latest", false])) as {number?: string; timestamp?: string} | null;
  } catch {
    parent = null;
  }
  const pinned = parent?.number && parent.timestamp ? parent : null;
  let blocks: {calls?: SimCall[]}[];
  try {
    blocks = (await input.rpc("eth_simulateV1", [{
      blockStateCalls: [{
        ...(pinned ? {blockOverrides: {time: hex(BigInt(pinned.timestamp!) + 1n)}} : {}),
        ...(input.stateOverrides ? {stateOverrides: overridesJson(input.stateOverrides)} : {}),
        calls: input.calls.map((c) => ({from: input.from, to: c.to, ...(c.data ? {data: c.data} : {}), value: hex(c.value ?? 0n)})),
      }],
      traceTransfers: true,
      validation: false,
    }, pinned ? pinned.number : "latest"])) as {calls?: SimCall[]}[];
  } catch (err) {
    if (simulateUnsupported(err)) return null;
    const msg = err instanceof Error ? err.message : String(err);
    return {status: "unavailable", reason: msg.slice(0, 200)};
  }
  const calls = blocks?.[0]?.calls ?? [];
  if (calls.length !== input.calls.length) return {status: "unavailable", reason: "simulation returned a different number of calls"};
  const failed = calls.findIndex((c) => c.status !== "0x1");
  if (failed >= 0) return {status: "reverted", callIndex: failed, reason: revertReason(calls[failed]!)};

  const me = lc(input.from);
  const deltas = new Map<string, bigint>();
  // Some wrapped natives (e.g. Sonic wS) emit a mint/burn Transfer alongside
  // Deposit/Withdrawal; the WETH9 events count only when no such Transfer did.
  const wethDeltas = new Map<string, bigint>();
  const mintBurn = new Set<string>();
  for (const c of calls) for (const log of c.logs ?? []) {
    const topic = lc(log.topics[0] ?? "");
    // WETH9 wrap/unwrap — counted only for contracts the caller lists as known (a
    // look-alike event from an arbitrary contract must not show as a balance change).
    if ((topic === WETH_DEPOSIT_TOPIC || topic === WETH_WITHDRAWAL_TOPIC) && log.topics.length === 2 && knownLabel(input.known ?? {}, lc(log.address))) {
      if (`0x${(log.topics[1] ?? "").slice(26)}` !== me) continue;
      let wad: bigint;
      try {
        wad = BigInt(log.data);
      } catch {
        continue;
      }
      const token = lc(log.address);
      wethDeltas.set(token, (wethDeltas.get(token) ?? 0n) + (topic === WETH_DEPOSIT_TOPIC ? wad : -wad));
      continue;
    }
    if (topic !== TRANSFER_TOPIC || log.topics.length !== 3) continue; // ERC-721 has 4 topics
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
    if ((from === me && to === ZERO_ADDR) || (from === ZERO_ADDR && to === me)) mintBurn.add(token);
  }
  for (const [token, d] of wethDeltas) if (!mintBurn.has(token)) deltas.set(token, (deltas.get(token) ?? 0n) + d);
  const native = input.native ?? {symbol: "ETH", decimals: 18};
  const changes: BalanceChange[] = [];
  for (const [token, delta] of deltas) {
    if (delta === 0n) continue;
    const meta = token === "native" ? native : await tokenMeta(input.rpc, token);
    changes.push({token, symbol: meta.symbol, decimals: meta.decimals, delta, verified: token === "native" || knownLabel(input.known ?? {}, token) !== null});
  }
  return {status: "ok", changes, gasUsed: calls.map((c) => BigInt(c.gasUsed ?? "0x0"))};
}

function revertReason(c: SimCall): string {
  const data = c.error?.data ?? c.returnData;
  // Error(string): 0x08c379a0 + offset + length + bytes.
  if (data && data.startsWith("0x08c379a0") && data.length >= 138) {
    try {
      const length = BigInt(`0x${data.slice(74, 138)}`);
      if (length > BigInt(data.length)) throw new Error("length past the data");
      const len = Number(length.toString());
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
      const length = BigInt(`0x${sym.slice(66, 130)}`);
      if (length > BigInt(sym.length)) throw new Error("length past the data");
      const len = Number(length.toString());
      symbol = hexToString(`0x${sym.slice(130, 130 + len * 2)}` as Hex) || null;
    } catch { /* ignore */ }
  } else if (sym && isHex(sym) && sym.length === 66) {
    try {
      symbol = hexToString(sym as Hex).replace(/\0+$/, "") || null; // bytes32 symbols (MKR-style)
    } catch { /* ignore */ }
  }
  let decimals: number | null = null;
  if (dec && isHex(dec) && dec.length > 2) {
    // Compared as a bigint: Hermes turns Number(x) above 2^63 into garbage that could pass `≤ 255`.
    const d = BigInt(dec);
    decimals = d <= 255n ? Number(d.toString()) : null;
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

/**
 * Decode the calls, simulate them in one block with `eth_simulateV1` (falling back to `eth_call`
 * when the node lacks it), and derive the checks.
 *
 * @throws Error when `calls` is empty.
 */
export async function previewEvmTx(input: PreviewInput): Promise<TxPreview> {
  if (!input.calls.length) throw new Error("tx-preview: no calls");
  const known = input.known ?? {};
  const calls = input.calls.map((c) => decodeCall(c, known));
  const simulation = (await simulateV1(input)) ?? (await callFallback(input));
  return {calls, simulation, checks: checksFor(input, calls, simulation)};
}

/**
 * Derive the review checks from decoded calls and a simulation. `previewEvmTx` calls it; use it
 * directly to re-check after your own simulation.
 */
export function checksFor(input: PreviewInput, calls: DecodedCall[], sim: Simulation): Check[] {
  const own = new Set(input.own.map(lc));
  own.add(lc(input.from));
  const checks: Check[] = [];

  // Every call is a contract the user is trusting — transfer-shaped ones included (a contract can
  // wear the selector): one check per target. Approvals are the exception: what they risk is the
  // spender and the amount, which the approval checks below cover.
  const main = calls[calls.length - 1]!;
  const seenTargets = new Set<string>();
  for (const c of calls) {
    if (!c.selector || c.approval || seenTargets.has(lc(c.to))) continue;
    seenTargets.add(lc(c.to));
    checks.push(c.label
      ? {code: "contract-known", status: "ok", detail: {label: c.label, address: c.to}}
      : {code: "contract-unknown", status: "warn", detail: {address: c.to}});
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
    else if (input.expectedApproval === undefined) checks.push({code: "approval-unchecked", status: "unknown", detail});
    else if (a.amount > input.expectedApproval) checks.push({code: "approval-excess", status: "warn", detail: {...detail, expected: input.expectedApproval.toString()}});
    else checks.push({code: "approval-exact", status: "ok", detail});
  }

  for (const c of calls) if (c.undecodable) checks.push({code: "calldata-undecodable", status: "warn", detail: {address: c.to}});

  // Native value per call into a contract: into one nobody vouched for it is a warning, not a tick.
  for (const c of calls) {
    if (c.value > 0n && c.selector) checks.push({code: "native-value", status: c.label ? "ok" : "warn", detail: {amount: c.value.toString(), ...(c.label ? {} : {address: c.to})}});
  }
  return checks;
}

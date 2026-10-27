/**
 * "What am I signing" for TON — offline. Decodes the messages of a
 * {@link TonSendable} (or a prebuilt V5R1 body) into human-checkable items and
 * flags the classic mistakes before any key is touched.
 */
import { Buffer } from 'buffer'
import { Address, Cell, beginCell, type MessageRelaxed, type Slice } from '@ton/core'
import { UnsafeTransactionError } from './errors.js'
import { DEFAULT_SEND_MODE, parseV5R1Body } from './wallet-v5r1.js'
import type { TonSendable, TonTransaction } from './types.js'

/** TEP-74 `transfer` op code of a jetton wallet. */
export const JETTON_TRANSFER_OP = 0x0f8a7ea5
const LARGE_FORWARD_NANOTON = 500_000_000n // 0.5 TON

/** What one outgoing message does. */
export type TonDescribedKind = 'ton-transfer' | 'jetton-transfer' | 'contract-call'

/** Fields of a TEP-74 jetton `transfer` body. */
export interface TonJettonDetails {
  queryId: bigint
  amount: bigint
  destination: string
  responseDestination: string | null
  forwardTonAmount: bigint
  forwardPayload: 'none' | 'comment' | 'cell'
  forwardComment?: string
  hasCustomPayload: boolean
}

/** One outgoing message of a wallet transaction, decoded. */
export interface TonDescribedMessage {
  kind: TonDescribedKind
  /** Destination as given (friendly) or raw `wc:hex`. */
  to: string
  value: bigint
  bounceable: boolean
  /** Test-only flag of a friendly address; undefined for raw addresses. */
  testOnly?: boolean
  /** Text comment (op 0). */
  comment?: string
  /** Body op code for contract calls (hex). */
  op?: string
  jetton?: TonJettonDetails
  hasStateInit: boolean
  bodyBits: number
  /**
   * Send mode the wallet sends the message with (IGNORE_ERRORS is always added for an external).
   * 128 carries the whole remaining balance, 32 destroys the account when it is left empty.
   */
  mode?: number
}

/** Problems a TON description is flagged with. */
export type TonWarningCode =
  | 'zero-value'
  | 'non-bounceable-contract-call'
  | 'unknown-body'
  | 'large-forward-amount'
  | 'testnet-address'
  | 'mainnet-address'
  | 'exotic-workchain'
  | 'extended-actions'
  | 'carries-all-balance'
  | 'destroys-account'

/** One flagged problem; `index` is the message it is about. */
export interface TonWarning { code: TonWarningCode; message: string; index?: number }

/**
 * A TON wallet transaction decoded for a confirmation screen: each outgoing message and the
 * warnings.
 */
export interface TonDescription {
  kind: TonDescribedKind | 'mixed'
  items: TonDescribedMessage[]
  warnings: TonWarning[]
  /** Present when the input was a prebuilt V5R1 body. */
  external?: { seqno: number; validUntil: number; walletId: bigint; signed: boolean }
}

/** A message body decoded: empty, a text comment, a jetton transfer, or unknown. */
export type DecodedBody =
  | { type: 'empty' }
  | { type: 'comment'; text: string }
  | { type: 'jetton-transfer'; jetton: TonJettonDetails }
  | { type: 'op'; op: number }
  | { type: 'unknown' }

/** Decode a message body cell. */
export function decodeBody(body: Cell): DecodedBody {
  const s = body.beginParse()
  if (s.remainingBits === 0 && s.remainingRefs === 0) return { type: 'empty' }
  if (s.remainingBits < 32) return { type: 'unknown' }
  const op = s.loadUint(32)
  try {
    if (op === 0) return { type: 'comment', text: s.loadStringTail() }
    if (op === JETTON_TRANSFER_OP) return { type: 'jetton-transfer', jetton: loadJettonTransfer(s) }
  } catch {
    return { type: 'unknown' }
  }
  return { type: 'op', op }
}

function loadJettonTransfer(s: Slice): TonJettonDetails {
  const queryId = s.loadUintBig(64)
  const amount = s.loadCoins()
  const destination = s.loadAddress()
  const responseDestination = s.loadMaybeAddress()
  const customPayload = s.loadMaybeRef()
  const forwardTonAmount = s.loadCoins()
  const inRef = s.loadBit()
  const payload: Slice = inRef ? s.loadRef().beginParse() : s
  let forwardPayload: TonJettonDetails['forwardPayload'] = 'none'
  let forwardComment: string | undefined
  if (payload.remainingBits > 0 || payload.remainingRefs > 0) {
    forwardPayload = 'cell'
    if (payload.remainingBits >= 32) {
      const p = payload.clone()
      if (p.loadUint(32) === 0) {
        try { forwardComment = p.loadStringTail(); forwardPayload = 'comment' } catch { /* not utf-8 */ }
      }
    }
  }
  return {
    queryId, amount, destination: destination.toString(), responseDestination: responseDestination ? responseDestination.toString() : null,
    forwardTonAmount, forwardPayload, ...(forwardComment !== undefined ? { forwardComment } : {}), hasCustomPayload: customPayload !== null,
  }
}

function parseTo(to: string): { to: string; bounceable: boolean; testOnly?: boolean; workchain: number } {
  if (Address.isFriendly(to)) {
    const f = Address.parseFriendly(to)
    return { to, bounceable: f.isBounceable, testOnly: f.isTestOnly, workchain: f.address.workChain }
  }
  const a = Address.parse(to)
  return { to: a.toRawString(), bounceable: true, workchain: a.workChain }
}

/** The forms @ton/core writes a BoC in (index or not, CRC or not). */
const BOC_FORMS = [{ idx: false, crc32: true }, { idx: false, crc32: false }, { idx: true, crc32: true }, { idx: true, crc32: false }] as const

/**
 * A base64 BoC as its single root Cell, only when @ton/core writes that Cell back byte-for-byte in
 * one of its forms. Anything it parses but would not write (a with_hashes cell whose hash area other
 * readers take for data, a level mask on an ordinary cell, extra roots) is refused, so every reader
 * of the string sees the cell that gets signed (scan 2026-10-27 F2, F4).
 */
export function canonicalBocCell(b64: string, what = 'bodyBoc'): Cell {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) throw new UnsafeTransactionError('non-canonical-boc', `${what} is not a base64 string.`)
  const bytes = Buffer.from(b64, 'base64')
  let roots: Cell[]
  try { roots = Cell.fromBoc(bytes) } catch { throw new UnsafeTransactionError('non-canonical-boc', `${what} is not a valid BoC.`) }
  const cell = roots.length === 1 ? roots[0]! : undefined
  if (!cell || !BOC_FORMS.some((form) => Buffer.from(cell.toBoc(form)).equals(bytes))) {
    throw new UnsafeTransactionError('non-canonical-boc', `${what} is not a canonical single-root BoC: its bytes do not round-trip, so what was reviewed may not be what is signed.`)
  }
  return cell
}

/**
 * The body a message is built with: a Cell, a text comment, or a canonical `bodyBoc`. A `body` that is
 * neither a string nor a Cell is refused rather than replaced by `bodyBoc` (scan 2026-10-27 F4).
 */
export function messageBody(tx: TonTransaction): Cell | undefined {
  if (tx.body instanceof Cell) return tx.body
  if (typeof tx.body === 'string') return tx.body === '' ? undefined : commentCell(tx.body)
  if (tx.body !== undefined) throw new UnsafeTransactionError('body', 'A message body must be a Cell or a string (a text comment).')
  if (tx.bodyBoc !== undefined && typeof tx.bodyBoc !== 'string') throw new UnsafeTransactionError('body', 'bodyBoc must be a base64 string.')
  return tx.bodyBoc ? canonicalBocCell(tx.bodyBoc) : undefined
}

function bodyOf(tx: TonTransaction): Cell | undefined {
  return messageBody(tx)
}

/** A text comment body (op 0 plus the text), as wallets show it. */
export function commentCell(text: string): Cell {
  return beginCell().storeUint(0, 32).storeStringTail(text).endCell()
}

function describeOne(
  i: number, to: ReturnType<typeof parseTo>, value: bigint, body: Cell | undefined, hasStateInit: boolean,
  bounceableOverride: boolean | undefined, warnings: TonWarning[], ctx: { network?: 'mainnet' | 'testnet' },
): TonDescribedMessage {
  const bounceable = bounceableOverride ?? to.bounceable
  const decoded = body ? decodeBody(body) : ({ type: 'empty' } as DecodedBody)
  const base = { to: to.to, value, bounceable, ...(to.testOnly !== undefined ? { testOnly: to.testOnly } : {}), hasStateInit, bodyBits: body ? body.bits.length : 0 }
  if (value <= 0n) warnings.push({ code: 'zero-value', message: 'message carries no TON; it cannot pay for gas at the destination', index: i })
  if (to.workchain !== 0 && to.workchain !== -1) warnings.push({ code: 'exotic-workchain', message: `workchain ${to.workchain}`, index: i })
  if (ctx.network && to.testOnly !== undefined) {
    if (to.testOnly && ctx.network !== 'testnet') warnings.push({ code: 'testnet-address', message: 'test-only address on a mainnet wallet', index: i })
    if (!to.testOnly && ctx.network === 'testnet') warnings.push({ code: 'mainnet-address', message: 'mainnet address on a testnet wallet', index: i })
  }
  let item: TonDescribedMessage
  switch (decoded.type) {
    case 'empty': item = { kind: 'ton-transfer', ...base }; break
    case 'comment': item = { kind: 'ton-transfer', ...base, comment: decoded.text }; break
    case 'jetton-transfer':
      item = { kind: 'jetton-transfer', ...base, jetton: decoded.jetton, op: hex(JETTON_TRANSFER_OP) }
      if (decoded.jetton.forwardTonAmount > LARGE_FORWARD_NANOTON) warnings.push({ code: 'large-forward-amount', message: `forward_ton_amount ${decoded.jetton.forwardTonAmount} > 0.5 TON`, index: i })
      break
    case 'op': item = { kind: 'contract-call', ...base, op: hex(decoded.op) }; break
    default:
      item = { kind: 'contract-call', ...base }
      warnings.push({ code: 'unknown-body', message: 'message body could not be decoded', index: i })
  }
  if (item.kind !== 'ton-transfer' && !bounceable) {
    warnings.push({ code: 'non-bounceable-contract-call', message: 'contract call to a non-bounceable address: TON is lost if the call fails', index: i })
  }
  return item
}

const hex = (n: number) => `0x${n.toString(16).padStart(8, '0')}`

/** SendMode.IGNORE_ERRORS: the V5R1 wallet always adds it to an external's messages. */
const IGNORE_ERRORS = 2
/** The mode a message given as {@link TonTransaction} is sent with: its `sendMode` or the default, plus IGNORE_ERRORS. */
export function sendModeOf(sendMode: number | undefined): number {
  return (sendMode ?? DEFAULT_SEND_MODE) | IGNORE_ERRORS
}
/** The drain modes in `mode`: 128 carries the whole remaining balance, 32 destroys the account once it is empty. */
export function drainModes(mode: number): Array<'carries-all-balance' | 'destroys-account'> {
  return [...((mode & 128) !== 0 ? ['carries-all-balance' as const] : []), ...((mode & 32) !== 0 ? ['destroys-account' as const] : [])]
}

function withMode(i: number, item: TonDescribedMessage, mode: number, warnings: TonWarning[]): TonDescribedMessage {
  for (const code of drainModes(mode)) {
    warnings.push({ code, message: code === 'carries-all-balance' ? 'send mode 128: the message carries the whole remaining balance' : 'send mode 32: the wallet account is destroyed once it is empty', index: i })
  }
  return { ...item, mode }
}

/** Describe one outgoing message and push its warnings into `warnings`. */
export function describeMessageRelaxed(i: number, m: MessageRelaxed, warnings: TonWarning[], ctx: { network?: 'mainnet' | 'testnet' } = {}): TonDescribedMessage {
  if (m.info.type !== 'internal') {
    warnings.push({ code: 'unknown-body', message: 'not an internal message', index: i })
    return { kind: 'contract-call', to: '', value: 0n, bounceable: false, hasStateInit: false, bodyBits: 0 }
  }
  const dest = m.info.dest
  const to = { to: dest.toString({ bounceable: m.info.bounce }), bounceable: m.info.bounce, workchain: dest.workChain }
  const body = m.body.bits.length === 0 && m.body.refs.length === 0 ? undefined : m.body
  return describeOne(i, to, m.info.value.coins, body, !!m.init, m.info.bounce, warnings, ctx)
}

/** Describe what a {@link TonSendable} will do. Offline; never throws on malformed bodies (they become warnings). */
export function describeTransaction(tx: TonSendable, ctx: { network?: 'mainnet' | 'testnet' } = {}): TonDescription {
  const warnings: TonWarning[] = []
  const items: TonDescribedMessage[] = []
  let external: TonDescription['external'] | undefined
  if (tx instanceof Cell) {
    const parsed = parseV5R1Body(tx)
    if (!parsed) {
      warnings.push({ code: 'unknown-body', message: 'not a V5R1 signed-external body' })
      return { kind: 'contract-call', items, warnings }
    }
    external = { seqno: parsed.seqno, validUntil: parsed.validUntil, walletId: parsed.walletId, signed: parsed.signed }
    parsed.messages.forEach((m, i) => items.push(withMode(i, describeMessageRelaxed(i, m.message, warnings, ctx), m.mode, warnings)))
  } else {
    const list = Array.isArray(tx) ? tx : [tx]
    list.forEach((t, i) => {
      let to: ReturnType<typeof parseTo>
      try { to = parseTo(t.to) } catch {
        warnings.push({ code: 'unknown-body', message: `invalid address: ${t.to}`, index: i })
        items.push({ kind: 'contract-call', to: t.to, value: 0n, bounceable: false, hasStateInit: false, bodyBits: 0 })
        return
      }
      let body: Cell | undefined
      try { body = bodyOf(t) } catch { warnings.push({ code: 'unknown-body', message: 'bodyBoc is not a valid BoC', index: i }) }
      items.push(withMode(i, describeOne(i, to, BigInt(t.value), body, t.stateInit !== undefined, t.bounceable, warnings, ctx), sendModeOf(t.sendMode), warnings))
    })
  }
  const kinds = new Set(items.map((x) => x.kind))
  const kind: TonDescription['kind'] = kinds.size === 1 ? items[0]!.kind : kinds.size === 0 ? 'contract-call' : 'mixed'
  return { kind, items, warnings, ...(external ? { external } : {}) }
}

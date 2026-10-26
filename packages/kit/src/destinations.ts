/**
 * Where a write goes, read off every transaction shape the chain packages
 * accept (scan F16/F17) — not only `to` / `recipient`. The allow/block lists
 * check every destination found here; when a shape cannot be read the write
 * is flagged `unknown` instead of silently passing.
 *
 * Self-contained on purpose (the kit has no chain-package dependencies and
 * runs on Hermes): a minimal reader for each wire format, used ONLY to find
 * destinations. The chain packages still verify the bytes strictly before
 * signing (wallet-tron refuses non-canonical `raw_data_hex`, scan F4), so a
 * transaction this reader understands differently is one they refuse.
 */

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export interface Destinations {
  /** Every destination found (recipients, called contracts / programs, NEAR receivers, TON message targets), in the form the call carries. */
  list: string[]
  /** Part of the write could not be read (an unknown shape, undecodable bytes, an address-lookup-table account): `list` may be incomplete. */
  unknown: boolean
}

const known = (list: Array<string | undefined>): Destinations => {
  const out = list.filter((d): d is string => d !== undefined && d !== '')
  return { list: [...new Set(out)], unknown: out.length !== list.length }
}
const UNKNOWN: Destinations = { list: [], unknown: true }

// ── encodings ────────────────────────────────────────────────────────────────

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Decode(s: string): Uint8Array | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s) || s.length > 128) return null
  let zeros = 0
  while (s[zeros] === '1') zeros++
  const le: number[] = [] // base 256, little-endian
  for (const ch of s) {
    let carry = B58.indexOf(ch)
    for (let j = 0; j < le.length; j++) { carry += le[j]! * 58; le[j] = carry & 0xff; carry >>= 8 }
    while (carry > 0) { le.push(carry & 0xff); carry >>= 8 }
  }
  const out = new Uint8Array(zeros + le.length)
  for (let k = 0; k < le.length; k++) out[zeros + k] = le[le.length - 1 - k]!
  return out
}

function base58Encode(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  const le: number[] = [] // base 58, little-endian
  for (let k = zeros; k < bytes.length; k++) {
    let carry = bytes[k]!
    for (let j = 0; j < le.length; j++) { carry += le[j]! << 8; le[j] = carry % 58; carry = (carry / 58) | 0 }
    while (carry > 0) { le.push(carry % 58); carry = (carry / 58) | 0 }
  }
  let out = '1'.repeat(zeros)
  for (let k = le.length - 1; k >= 0; k--) out += B58[le[k]!]
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
/** Far above any real wire transaction (Solana ≤ 1 232 bytes, NEAR ≤ 4 MiB): longer input is not decoded at all. */
const MAX_BASE64_CHARS = 8 * 1024 * 1024

function base64Decode(s: string): Uint8Array | null {
  if (s.length > MAX_BASE64_CHARS) return null
  // Strip the padding with a linear walk: the old /=+$/ was quadratic on a long '====…A' run (scan 2026-10-23 F11).
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 61 /* = */) end--
  const clean = s.slice(0, end).replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) return null
  const out: number[] = []
  let buf = 0
  let bits = 0
  for (const ch of clean) {
    buf = ((buf << 6) | B64.indexOf(ch)) & 0xffffff
    bits += 6
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff) }
  }
  return Uint8Array.from(out)
}

/** Latin-1 view of bytes: type URLs and NEAR account ids are ASCII (anything else fails their checks). No TextDecoder: Hermes. */
const ascii = (b: Uint8Array) => { let out = ''; for (const x of b) out += String.fromCharCode(x); return out }
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const fromHex = (h: string): Uint8Array | null => {
  const s = h.replace(/^0x/, '')
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) return null
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16)
  return out
}

// ── canonical forms (comparison only) ────────────────────────────────────────

/** Tron: any accepted form (base58 T…, hex 41…, 0x41…) → lowercase 21-byte hex `41…`. */
export function tronHexAddress(address: string): string | null {
  if (/^(0x)?41[0-9a-fA-F]{40}$/.test(address)) return address.replace(/^0x/, '').toLowerCase()
  const b = base58Decode(address)
  return b && b.length === 25 && b[0] === 0x41 ? toHex(b.subarray(0, 21)) : null
}

/** TON: raw `wc:hex` or a friendly (base64 / base64url, 36 bytes) address → `wc:hex` lowercase. */
export function tonRawAddress(address: string): string | null {
  const raw = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(address)
  if (raw) return `${Number(raw[1])}:${raw[2]!.toLowerCase()}`
  if (address.length !== 48) return null
  const b = base64Decode(address)
  if (!b || b.length !== 36) return null
  const wc = b[1]! > 127 ? b[1]! - 256 : b[1]!
  return `${wc}:${toHex(b.subarray(2, 34))}`
}

/** The form the allow/block lists compare in, per chain namespace: EVM lowercase, Tron hex, TON raw; anything else lowercase. */
export function canonicalAddress(chain: string, address: string): string {
  const ns = chain.split(':')[0]
  if (ns === 'tron') return tronHexAddress(address) ?? address.toLowerCase()
  if (ns === 'ton') return tonRawAddress(address) ?? address.toLowerCase()
  return address.toLowerCase()
}

// ── Tron: Transaction.raw (protobuf) ─────────────────────────────────────────

class Reader {
  i = 0
  constructor(readonly b: Uint8Array) {}
  get done() { return this.i >= this.b.length }
  varint(): number {
    let v = 0
    let mul = 1
    for (let n = 0; n < 10; n++) {
      if (this.i >= this.b.length) throw new Error('truncated varint')
      const byte = this.b[this.i++]!
      v += (byte & 0x7f) * mul
      if ((byte & 0x80) === 0) return v
      mul *= 128
    }
    throw new Error('varint too long')
  }
  bytes(n: number): Uint8Array {
    if (n < 0 || this.i + n > this.b.length) throw new Error('truncated')
    const out = this.b.subarray(this.i, this.i + n)
    this.i += n
    return out
  }
  /** Protobuf fields: `[number, wire, value]` with length-delimited values as bytes. */
  fields(): Array<[number, number, Uint8Array | number]> {
    const out: Array<[number, number, Uint8Array | number]> = []
    while (!this.done) {
      const tag = this.varint()
      const number = Math.floor(tag / 8)
      const wire = tag % 8
      if (wire === 0) out.push([number, wire, this.varint()])
      else if (wire === 2) out.push([number, wire, this.bytes(this.varint())])
      else if (wire === 1) out.push([number, wire, this.bytes(8)])
      else if (wire === 5) out.push([number, wire, this.bytes(4)])
      else throw new Error(`wire type ${wire}`)
    }
    return out
  }
}

/** Address-typed fields that name where a Tron contract sends value or calls: to_address (Transfer / TransferAsset), contract_address (TriggerSmartContract), receiver_address (DelegateResource / UnDelegateResource). */
const TRON_DESTINATION_FIELDS: Record<string, number[]> = {
  TransferContract: [2],
  TransferAssetContract: [3],
  TriggerSmartContract: [2],
  DelegateResourceContract: [4],
  UnDelegateResourceContract: [4],
}
/** Contracts that move nothing to anyone else (stake, vote, withdraw to self): no destination, and not "unknown". */
const TRON_SELF_CONTRACTS = new Set(['FreezeBalanceContract', 'UnfreezeBalanceContract', 'FreezeBalanceV2Contract', 'UnfreezeBalanceV2Contract', 'WithdrawExpireUnfreezeContract', 'CancelAllUnfreezeV2Contract', 'WithdrawBalanceContract', 'VoteWitnessContract'])
const TRON_TYPE_BY_ENUM: Record<number, string> = { 1: 'TransferContract', 2: 'TransferAssetContract', 4: 'VoteWitnessContract', 11: 'FreezeBalanceContract', 12: 'UnfreezeBalanceContract', 13: 'WithdrawBalanceContract', 31: 'TriggerSmartContract', 54: 'FreezeBalanceV2Contract', 55: 'UnfreezeBalanceV2Contract', 56: 'WithdrawExpireUnfreezeContract', 57: 'DelegateResourceContract', 58: 'UnDelegateResourceContract', 59: 'CancelAllUnfreezeV2Contract' }

/** Destinations of `raw_data_hex` — the bytes the signature covers. */
export function tronRawDestinations(rawHex: string): Destinations {
  try {
    const bytes = fromHex(rawHex)
    if (!bytes || bytes.length === 0) return UNKNOWN
    const out: Array<string | undefined> = []
    let contracts = 0
    for (const [n, w, v] of new Reader(bytes).fields()) {
      if (n !== 11 || w !== 2) continue
      contracts++
      let enumType: number | undefined
      let typeUrl: string | undefined
      let param: Uint8Array | undefined
      for (const [cn, cw, cv] of new Reader(v as Uint8Array).fields()) {
        if (cn === 1 && cw === 0) enumType = cv as number
        else if (cn === 2 && cw === 2) {
          for (const [an, aw, av] of new Reader(cv as Uint8Array).fields()) {
            if (an === 1 && aw === 2) typeUrl = ascii(av as Uint8Array)
            else if (an === 2 && aw === 2) param = av as Uint8Array
          }
        }
      }
      const type = typeUrl?.split('.').pop() ?? (enumType !== undefined ? TRON_TYPE_BY_ENUM[enumType] : undefined)
      if (!type || !param) { out.push(undefined); continue }
      if (TRON_SELF_CONTRACTS.has(type)) continue
      const wanted = TRON_DESTINATION_FIELDS[type]
      if (!wanted) { out.push(undefined); continue }
      const found = new Reader(param).fields().filter(([pn, pw, pv]) => wanted.includes(pn) && pw === 2 && (pv as Uint8Array).length === 21)
      if (found.length === 0) out.push(undefined)
      for (const [, , pv] of found) out.push(toHex(pv as Uint8Array))
    }
    if (contracts === 0) return UNKNOWN
    return known(out)
  } catch {
    return UNKNOWN
  }
}

// ── NEAR: borsh Transaction / SignedTransaction prefix ───────────────────────

const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/

function nearReceiverOfBorsh(b64: string): string | undefined {
  const b = base64Decode(b64)
  if (!b) return undefined
  let i = 0
  const u32 = () => { if (i + 4 > b.length) throw new Error('truncated'); const v = b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24); i += 4; return v >>> 0 }
  const string = () => { const n = u32(); if (n > 64 || i + n > b.length) throw new Error('bad string'); const s = ascii(b.subarray(i, i + n)); i += n; return s }
  try {
    const signer = string()
    if (!NEAR_ACCOUNT.test(signer)) return undefined
    const keyType = b[i++]
    i += keyType === 0 ? 32 : keyType === 1 ? 64 : NaN
    i += 8 // nonce
    const receiver = string()
    return NEAR_ACCOUNT.test(receiver) ? receiver : undefined
  } catch {
    return undefined
  }
}

// ── Solana: wire transaction / message / kit TransactionMessage ─────────────

const SYSTEM = '11111111111111111111111111111111'
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
/** Programs that move nothing to anyone: compute budget, memo, associated-token-account creation (rent only). */
const SOLANA_NEUTRAL = new Set(['ComputeBudget111111111111111111111111111111', 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'])

interface SolIx { program: string | undefined; accounts: Array<string | undefined>; data: Uint8Array }

/** One instruction → where it sends: the recipient of a SOL / SPL transfer, a delegate, a close destination, else the program called. */
function solanaIxDestinations(ix: SolIx): Array<string | undefined> {
  if (ix.program === undefined) return [undefined]
  if (SOLANA_NEUTRAL.has(ix.program)) return []
  const d = ix.data
  if (ix.program === SYSTEM) {
    const disc = d.length >= 4 ? d[0]! | (d[1]! << 8) | (d[2]! << 16) | (d[3]! << 24) : -1
    if (disc === 2 || disc === 0 || disc === 3) return [ix.accounts[1]] // Transfer, CreateAccount(WithSeed): the funded account
    if (disc === 11) return [ix.accounts[2]] // TransferWithSeed
    if (disc === 4) return [] // AdvanceNonceAccount
    return [undefined] // Assign / Allocate / nonce authority changes: not something a destination list can judge
  }
  if (ix.program === TOKEN || ix.program === TOKEN_2022) {
    switch (d[0]) {
      case 3: case 4: case 9: return [ix.accounts[1]] // Transfer, Approve (delegate), CloseAccount (lamports to)
      case 12: case 13: return [ix.accounts[2]] // TransferChecked, ApproveChecked
      case 1: case 5: case 16: case 17: case 18: return [] // InitializeAccount(2/3), Revoke, SyncNative
      default: return [undefined]
    }
  }
  return [ix.program]
}

function shortvec(b: Uint8Array, at: { i: number }): number {
  let v = 0
  for (let n = 0; n < 3; n++) {
    const byte = b[at.i++]
    if (byte === undefined) throw new Error('truncated')
    v |= (byte & 0x7f) << (7 * n)
    if ((byte & 0x80) === 0) return v
  }
  throw new Error('shortvec too long')
}

function solanaMessageInstructions(msg: Uint8Array): SolIx[] {
  const at = { i: 0 }
  if (msg[0]! & 0x80) at.i = 1 // versioned (v0): lookup-table accounts are not resolvable here
  at.i += 3 // header
  const nKeys = shortvec(msg, at)
  const keys: string[] = []
  for (let k = 0; k < nKeys; k++) {
    if (at.i + 32 > msg.length) throw new Error('truncated')
    keys.push(base58Encode(msg.subarray(at.i, at.i + 32)))
    at.i += 32
  }
  at.i += 32 // recent blockhash
  const nIx = shortvec(msg, at)
  const out: SolIx[] = []
  for (let n = 0; n < nIx; n++) {
    const program = keys[msg[at.i++]!]
    const nAcc = shortvec(msg, at)
    const accounts: Array<string | undefined> = []
    for (let a = 0; a < nAcc; a++) accounts.push(keys[msg[at.i++]!])
    const len = shortvec(msg, at)
    if (at.i + len > msg.length) throw new Error('truncated')
    out.push({ program, accounts, data: msg.subarray(at.i, at.i + len) })
    at.i += len
  }
  return out
}

function solanaWireInstructions(wire: Uint8Array): SolIx[] {
  const at = { i: 0 }
  const nSigs = shortvec(wire, at)
  return solanaMessageInstructions(wire.subarray(at.i + 64 * nSigs))
}

function fromIxList(list: SolIx[]): Destinations {
  if (list.length === 0) return UNKNOWN
  return known(list.flatMap(solanaIxDestinations))
}

function solanaDestinations(arg: unknown): Destinations {
  try {
    if (typeof arg === 'string') {
      const b = base64Decode(arg)
      return b ? fromIxList(solanaWireInstructions(b)) : UNKNOWN
    }
    // wallet-solana's own order (guards.ts): a compiled transaction has messageBytes AND signatures,
    // a native transfer has `to` AND `value`, a message has `instructions`. An object that fits two
    // of these is not judged by either reading (round 3, H2).
    const a = obj(arg)
    const compiled = 'messageBytes' in a && 'signatures' in a
    const native = 'to' in a && 'value' in a
    const message = Array.isArray(a.instructions)
    if (Number(compiled) + Number(native) + Number(message) !== 1) return UNKNOWN
    if (compiled) return a.messageBytes instanceof Uint8Array ? fromIxList(solanaMessageInstructions(a.messageBytes)) : UNKNOWN
    if (native) { const to = str(a.to); return to !== undefined ? known([to]) : UNKNOWN }
    return fromIxList((a.instructions as unknown[]).map((raw) => {
      const ix = obj(raw)
      const data = ix.data instanceof Uint8Array ? ix.data : new Uint8Array()
      const accounts = Array.isArray(ix.accounts) ? ix.accounts.map((acc) => str(obj(acc).address)) : []
      return { program: str(ix.programAddress), accounts, data }
    }))
  } catch {
    return UNKNOWN
  }
}

// ── per chain ────────────────────────────────────────────────────────────────

function tronDestinations(arg: unknown): Destinations {
  let a: Record<string, unknown>
  if (typeof arg === 'string') {
    try { a = obj(JSON.parse(arg)) } catch { return UNKNOWN }
  } else a = obj(arg)
  // wallet-tron's own order (shape.ts): prebuilt when `txID` is a string, a contract call when
  // `functionSelector` is, otherwise a TRX send to `to`. Fields of another shape riding along make
  // the reading ambiguous (round 3, H2).
  const prebuilt = typeof a.txID === 'string'
  const call = typeof a.functionSelector === 'string'
  const foreign = (...keys: string[]) => keys.some((k) => a[k] !== undefined)
  if (prebuilt) {
    // Only the signed bytes count, never the JSON copy next to them (scan F17).
    if (call || foreign('to', 'contractAddress', 'value')) return UNKNOWN
    return typeof a.raw_data_hex === 'string' ? tronRawDestinations(a.raw_data_hex) : UNKNOWN
  }
  if (foreign('raw_data', 'raw_data_hex', 'txID')) return UNKNOWN
  if (call) {
    if (foreign('to', 'value')) return UNKNOWN
    const c = str(a.contractAddress)
    return c !== undefined ? known([c]) : UNKNOWN
  }
  if (foreign('contractAddress')) return UNKNOWN
  const to = str(a.to)
  return to !== undefined ? known([to]) : UNKNOWN
}

function nearDestinations(arg: unknown): Destinations {
  if (typeof arg === 'string') { const r = nearReceiverOfBorsh(arg); return r ? known([r]) : UNKNOWN }
  // wallet-near builds from `receiverId` and nothing else (round 3, review).
  const to = str(obj(arg).receiverId)
  return to !== undefined ? known([to]) : UNKNOWN
}

function tonDestinations(arg: unknown): Destinations {
  if (Array.isArray(arg)) return arg.length ? known(arg.map((m) => str(obj(m).to))) : UNKNOWN
  // wallet-ton builds from `to` and nothing else (round 3, review).
  const to = str(obj(arg).to)
  return to !== undefined ? known([to]) : UNKNOWN // a Cell (prebuilt external) is not read here
}

/** EVM: the transaction goes to `to` and nowhere else — no `to` is a contract deployment (round 3, H2). */
function evmDestinations(arg: unknown): Destinations {
  if (Array.isArray(arg)) return arg.length ? known(arg.map((c) => str(obj(c).to))) : UNKNOWN
  const to = str(obj(arg).to)
  return to !== undefined ? known([to]) : UNKNOWN
}

function evmLikeDestinations(arg: unknown): Destinations {
  if (Array.isArray(arg)) return arg.length ? known(arg.map((c) => str(obj(c).to))) : UNKNOWN
  const a = obj(arg)
  const to = str(a.to) ?? str(a.recipient)
  return to !== undefined ? known([to]) : UNKNOWN
}

/** Destinations of a value-moving write (`kind: 'send'`) on `chain` (CAIP-2). */
export function sendDestinations(chain: string, arg: unknown): Destinations {
  switch (chain.split(':')[0]) {
    case 'tron': return tronDestinations(arg)
    case 'near': return nearDestinations(arg)
    case 'ton': return tonDestinations(arg)
    case 'solana': return solanaDestinations(arg)
    case 'eip155': return evmDestinations(arg)
    default: return evmLikeDestinations(arg)
  }
}

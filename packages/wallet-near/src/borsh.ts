/**
 * Borsh (https://borsh.io) for NEAR transactions — the exact layout nearcore and
 * @near-js/transactions use, written by hand so the package has no borsh dependency:
 * little-endian integers, u32-length-prefixed strings / vectors, u8 enum tags.
 */
import type {
  NearAccessKey, NearAction, NearBuiltTransaction, NearDelegateAction, NearPublicKey, NearSignature, NearSignedTransaction,
} from './types.js'

const utf8 = new TextEncoder()
const utf8d = new TextDecoder()

/** @internal Minimal borsh encoder for NEAR transactions. */
export class BorshWriter {
  private _buf = new Uint8Array(256)
  private _len = 0

  private ensure(n: number) {
    if (this._len + n <= this._buf.length) return
    const next = new Uint8Array(Math.max(this._buf.length * 2, this._len + n))
    next.set(this._buf.subarray(0, this._len))
    this._buf = next
  }
  u8(v: number) { this.ensure(1); this._buf[this._len++] = v & 0xff; return this }
  u32(v: number) {
    this.ensure(4)
    for (let i = 0; i < 4; i++) this._buf[this._len++] = (v >>> (8 * i)) & 0xff
    return this
  }
  uint(v: bigint, bytes: number) {
    if (v < 0n || v >= 1n << BigInt(8 * bytes)) throw new RangeError(`u${8 * bytes} out of range: ${v}`)
    this.ensure(bytes)
    for (let i = 0; i < bytes; i++) this._buf[this._len++] = Number((v >> BigInt(8 * i)) & 0xffn)
    return this
  }
  u64(v: bigint) { return this.uint(v, 8) }
  u128(v: bigint) { return this.uint(v, 16) }
  bytes(b: Uint8Array) { this.ensure(b.length); this._buf.set(b, this._len); this._len += b.length; return this }
  /** Vec<u8> / String: u32 length + bytes. */
  vecU8(b: Uint8Array) { return this.u32(b.length).bytes(b) }
  string(s: string) { return this.vecU8(utf8.encode(s)) }
  option<T>(v: T | undefined, write: (v: T) => void) {
    if (v === undefined) return this.u8(0)
    this.u8(1)
    write(v)
    return this
  }
  toBytes(): Uint8Array { return this._buf.slice(0, this._len) }
}

/** @internal Minimal borsh decoder for NEAR transactions. */
export class BorshReader {
  private _pos = 0
  constructor(private readonly _buf: Uint8Array) {}
  get remaining(): number { return this._buf.length - this._pos }
  private need(n: number) { if (this._pos + n > this._buf.length) throw new RangeError('borsh: unexpected end of input') }
  u8(): number { this.need(1); return this._buf[this._pos++]! }
  u32(): number {
    this.need(4)
    let v = 0
    for (let i = 0; i < 4; i++) v |= this._buf[this._pos++]! << (8 * i)
    return v >>> 0
  }
  uint(bytes: number): bigint {
    this.need(bytes)
    let v = 0n
    for (let i = 0; i < bytes; i++) v |= BigInt(this._buf[this._pos++]!) << BigInt(8 * i)
    return v
  }
  u64(): bigint { return this.uint(8) }
  u128(): bigint { return this.uint(16) }
  bytes(n: number): Uint8Array { this.need(n); const out = this._buf.slice(this._pos, this._pos + n); this._pos += n; return out }
  vecU8(): Uint8Array { return this.bytes(this.u32()) }
  string(): string { return utf8d.decode(this.vecU8()) }
  option<T>(read: () => T): T | undefined { return this.u8() === 0 ? undefined : read() }
  done(): void { if (this.remaining !== 0) throw new RangeError(`borsh: ${this.remaining} trailing bytes`) }
}

// ── Keys / signatures ────────────────────────────────────────────────────────

const KEY_TYPE = { ed25519: 0, secp256k1: 1 } as const
const KEY_LEN = { ed25519: 32, secp256k1: 64 } as const
const SIG_LEN = { ed25519: 64, secp256k1: 65 } as const

export function writePublicKey(w: BorshWriter, k: NearPublicKey): void {
  if (k.data.length !== KEY_LEN[k.keyType]) throw new RangeError(`${k.keyType} public key must be ${KEY_LEN[k.keyType]} bytes`)
  w.u8(KEY_TYPE[k.keyType]).bytes(k.data)
}
export function readPublicKey(r: BorshReader): NearPublicKey {
  const t = r.u8()
  const keyType = t === 0 ? 'ed25519' : t === 1 ? 'secp256k1' : undefined
  if (!keyType) throw new RangeError(`borsh: unknown key type ${t}`)
  return { keyType, data: r.bytes(KEY_LEN[keyType]) }
}
export function writeSignature(w: BorshWriter, s: NearSignature): void {
  if (s.data.length !== SIG_LEN[s.keyType]) throw new RangeError(`${s.keyType} signature must be ${SIG_LEN[s.keyType]} bytes`)
  w.u8(KEY_TYPE[s.keyType]).bytes(s.data)
}
export function readSignature(r: BorshReader): NearSignature {
  const t = r.u8()
  const keyType = t === 0 ? 'ed25519' : t === 1 ? 'secp256k1' : undefined
  if (!keyType) throw new RangeError(`borsh: unknown signature type ${t}`)
  return { keyType, data: r.bytes(SIG_LEN[keyType]) }
}

// ── Actions ──────────────────────────────────────────────────────────────────

/** Enum order from nearcore `Action` (and @near-js/transactions SCHEMA.Action). */
export const ACTION_TAG = {
  createAccount: 0, deployContract: 1, functionCall: 2, transfer: 3, stake: 4, addKey: 5, deleteKey: 6, deleteAccount: 7,
  signedDelegate: 8, deployGlobalContract: 9, useGlobalContract: 10,
} as const
export type NearActionKey = keyof typeof ACTION_TAG

export function actionKey(a: NearAction): NearActionKey {
  const k = Object.keys(a)[0] as NearActionKey | undefined
  if (!k || !(k in ACTION_TAG)) throw new RangeError(`unknown action ${k}`)
  return k
}

/** Function-call args as bytes: raw bytes pass through; objects / strings become UTF-8 JSON / UTF-8. */
export function argsBytes(args: Uint8Array | Record<string, unknown> | string): Uint8Array {
  if (args instanceof Uint8Array) return args
  if (typeof args === 'string') return utf8.encode(args)
  return utf8.encode(JSON.stringify(args))
}

function writeAccessKey(w: BorshWriter, k: NearAccessKey): void {
  w.u64(k.nonce)
  if ('functionCall' in k.permission) {
    const p = k.permission.functionCall
    w.u8(0)
    w.option(p.allowance, (a) => w.u128(a))
    w.string(p.receiverId)
    w.u32(p.methodNames.length)
    for (const m of p.methodNames) w.string(m)
  } else {
    w.u8(1)
  }
}
function readAccessKey(r: BorshReader): NearAccessKey {
  const nonce = r.u64()
  const t = r.u8()
  if (t === 0) {
    const allowance = r.option(() => r.u128())
    const receiverId = r.string()
    const n = r.u32()
    const methodNames: string[] = []
    for (let i = 0; i < n; i++) methodNames.push(r.string())
    return { nonce, permission: { functionCall: { ...(allowance !== undefined ? { allowance } : {}), receiverId, methodNames } } }
  }
  if (t === 1) return { nonce, permission: { fullAccess: {} } }
  throw new RangeError(`borsh: unknown access-key permission ${t}`)
}

function writeDelegateAction(w: BorshWriter, d: NearDelegateAction): void {
  w.string(d.senderId).string(d.receiverId)
  w.u32(d.actions.length)
  for (const a of d.actions) writeAction(w, a)
  w.u64(d.nonce).u64(d.maxBlockHeight)
  writePublicKey(w, d.publicKey)
}
function readDelegateAction(r: BorshReader): NearDelegateAction {
  const senderId = r.string()
  const receiverId = r.string()
  const n = r.u32()
  const actions: NearAction[] = []
  for (let i = 0; i < n; i++) actions.push(readAction(r))
  const nonce = r.u64()
  const maxBlockHeight = r.u64()
  return { senderId, receiverId, actions, nonce, maxBlockHeight, publicKey: readPublicKey(r) }
}

export function writeAction(w: BorshWriter, a: NearAction): void {
  const key = actionKey(a)
  w.u8(ACTION_TAG[key])
  switch (key) {
    case 'createAccount': return
    case 'deployContract': w.vecU8((a as { deployContract: { code: Uint8Array } }).deployContract.code); return
    case 'functionCall': {
      const f = (a as { functionCall: { methodName: string; args: Uint8Array | Record<string, unknown> | string; gas?: bigint; deposit?: bigint } }).functionCall
      w.string(f.methodName).vecU8(argsBytes(f.args)).u64(f.gas ?? 30n * 10n ** 12n).u128(f.deposit ?? 0n)
      return
    }
    case 'transfer': w.u128((a as { transfer: { deposit: bigint } }).transfer.deposit); return
    case 'stake': {
      const s = (a as { stake: { stake: bigint; publicKey: NearPublicKey } }).stake
      w.u128(s.stake)
      writePublicKey(w, s.publicKey)
      return
    }
    case 'addKey': {
      const k = (a as { addKey: { publicKey: NearPublicKey; accessKey: NearAccessKey } }).addKey
      writePublicKey(w, k.publicKey)
      writeAccessKey(w, k.accessKey)
      return
    }
    case 'deleteKey': writePublicKey(w, (a as { deleteKey: { publicKey: NearPublicKey } }).deleteKey.publicKey); return
    case 'deleteAccount': w.string((a as { deleteAccount: { beneficiaryId: string } }).deleteAccount.beneficiaryId); return
    case 'signedDelegate': {
      const d = (a as { signedDelegate: { delegateAction: NearDelegateAction; signature: NearSignature } }).signedDelegate
      writeDelegateAction(w, d.delegateAction)
      writeSignature(w, d.signature)
      return
    }
    case 'deployGlobalContract': {
      const g = (a as { deployGlobalContract: { code: Uint8Array; deployMode: 'codeHash' | 'accountId' } }).deployGlobalContract
      w.vecU8(g.code).u8(g.deployMode === 'codeHash' ? 0 : 1)
      return
    }
    case 'useGlobalContract': {
      const u = (a as { useGlobalContract: { codeHash: Uint8Array } | { accountId: string } }).useGlobalContract
      if ('codeHash' in u) { w.u8(0).bytes(u.codeHash) } else { w.u8(1).string(u.accountId) }
      return
    }
  }
}

export function readAction(r: BorshReader): NearAction {
  const tag = r.u8()
  switch (tag) {
    case 0: return { createAccount: {} }
    case 1: return { deployContract: { code: r.vecU8() } }
    case 2: {
      const methodName = r.string()
      const args = r.vecU8()
      const gas = r.u64()
      const deposit = r.u128()
      return { functionCall: { methodName, args, gas, deposit } }
    }
    case 3: return { transfer: { deposit: r.u128() } }
    case 4: { const stake = r.u128(); return { stake: { stake, publicKey: readPublicKey(r) } } }
    case 5: { const publicKey = readPublicKey(r); return { addKey: { publicKey, accessKey: readAccessKey(r) } } }
    case 6: return { deleteKey: { publicKey: readPublicKey(r) } }
    case 7: return { deleteAccount: { beneficiaryId: r.string() } }
    case 8: { const delegateAction = readDelegateAction(r); return { signedDelegate: { delegateAction, signature: readSignature(r) } } }
    case 9: { const code = r.vecU8(); const m = r.u8(); return { deployGlobalContract: { code, deployMode: m === 0 ? 'codeHash' : 'accountId' } } }
    case 10: { const m = r.u8(); return { useGlobalContract: m === 0 ? { codeHash: r.bytes(32) } : { accountId: r.string() } } }
    default: throw new RangeError(`borsh: unknown action tag ${tag}`)
  }
}

// ── Transactions ─────────────────────────────────────────────────────────────

/** Borsh bytes of an unsigned transaction. */
export function encodeTransaction(tx: NearBuiltTransaction): Uint8Array {
  if (tx.blockHash.length !== 32) throw new RangeError('blockHash must be 32 bytes')
  const w = new BorshWriter()
  w.string(tx.signerId)
  writePublicKey(w, tx.publicKey)
  w.u64(tx.nonce).string(tx.receiverId).bytes(tx.blockHash)
  w.u32(tx.actions.length)
  for (const a of tx.actions) writeAction(w, a)
  return w.toBytes()
}

export function readTransaction(r: BorshReader): NearBuiltTransaction {
  const signerId = r.string()
  const publicKey = readPublicKey(r)
  const nonce = r.u64()
  const receiverId = r.string()
  const blockHash = r.bytes(32)
  const n = r.u32()
  const actions: NearAction[] = []
  for (let i = 0; i < n; i++) actions.push(readAction(r))
  return { signerId, publicKey, nonce, receiverId, blockHash, actions }
}

/** Decode an unsigned transaction from borsh bytes. */
export function decodeTransaction(bytes: Uint8Array): NearBuiltTransaction {
  const r = new BorshReader(bytes)
  const tx = readTransaction(r)
  r.done()
  return tx
}

/** Borsh bytes of a signed transaction, ready to broadcast as base64. */
export function encodeSignedTransaction(s: NearSignedTransaction): Uint8Array {
  const w = new BorshWriter()
  w.bytes(encodeTransaction(s.transaction))
  writeSignature(w, s.signature)
  return w.toBytes()
}

/** Decode a signed transaction from borsh bytes. */
export function decodeSignedTransaction(bytes: Uint8Array): NearSignedTransaction {
  const r = new BorshReader(bytes)
  const transaction = readTransaction(r)
  const signature = readSignature(r)
  r.done()
  return { transaction, signature }
}

/** Unsigned or signed borsh bytes → the transaction (and signature when present). */
export function decodeAnyTransaction(bytes: Uint8Array): { transaction: NearBuiltTransaction; signature?: NearSignature } {
  const r = new BorshReader(bytes)
  const transaction = readTransaction(r)
  if (r.remaining === 0) return { transaction }
  const signature = readSignature(r)
  r.done()
  return { transaction, signature }
}

/**
 * Zcash v5 transactions (ZIP-225 format) carrying transparent inputs and
 * outputs only — the shielded bundles are serialized empty. Transaction ids and
 * signature hashes follow ZIP-244 (BLAKE2b-256 digest tree); the consensus
 * branch id is part of both, so a transaction signed for one network upgrade
 * is invalid under the next.
 */
import { blake2b } from '@noble/hashes/blake2.js'
import { Reader, Writer, bytesToHex, compactSize, hexToBytes, i64le, reverseBytes, u32le, utf8ToBytes } from './encoding.js'
import type { SpentOutput } from './types.js'

export const TX_VERSION_V5 = 0x80000005 // fOverwintered | 5
export const VERSION_GROUP_ID_V5 = 0x26a7270a
export const SIGHASH_ALL = 0x01

/** Mainnet network upgrades and their consensus branch ids (ZIP-200 table), oldest first. */
export const MAINNET_UPGRADES: ReadonlyArray<{ name: string; height: number; branchId: number }> = Object.freeze([
  { name: 'NU5', height: 1_687_104, branchId: 0xc2d6d0b4 },
  { name: 'NU6', height: 2_726_400, branchId: 0xc8e71055 },
  { name: 'NU6.1', height: 3_146_400, branchId: 0x4dec4df0 },
  { name: 'NU6.3', height: 3_428_143, branchId: 0x37a5165b },
])

/** The branch id the current mainnet tip signs under (NU6.3 "Ironwood", active since block 3 428 143, 2026-07-28). */
export const CURRENT_BRANCH_ID = MAINNET_UPGRADES[MAINNET_UPGRADES.length - 1]!.branchId

/** Branch id in force at `height` on mainnet (the newest upgrade when the height is unknown or ahead of the table). */
export function branchIdForHeight(height: number | undefined): number {
  if (height === undefined || !Number.isFinite(height)) return CURRENT_BRANCH_ID
  let id = MAINNET_UPGRADES[0]!.branchId
  for (const u of MAINNET_UPGRADES) if (height >= u.height) id = u.branchId
  return id
}

export interface TxInput {
  /** Display-order hex (as explorers show it). */
  txid: string
  vout: number
  scriptSig: Uint8Array
  sequence: number
}

export interface TxOutput {
  value: bigint
  script: Uint8Array
}

export interface TransparentTxV5 {
  consensusBranchId: number
  lockTime: number
  expiryHeight: number
  inputs: TxInput[]
  outputs: TxOutput[]
}

export const FINAL_SEQUENCE = 0xfffffffe
export const MAX_SEQUENCE = 0xffffffff

const assertTxid = (txid: string) => { if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error(`Invalid txid: ${txid}`) }

function writeTransparent(w: Writer, tx: TransparentTxV5): void {
  w.compact(tx.inputs.length)
  for (const i of tx.inputs) {
    assertTxid(i.txid)
    w.bytes(reverseBytes(hexToBytes(i.txid))).u32(i.vout).varBytes(i.scriptSig).u32(i.sequence)
  }
  w.compact(tx.outputs.length)
  for (const o of tx.outputs) {
    if (o.value < 0n) throw new Error('Negative output value')
    w.i64(o.value).varBytes(o.script)
  }
}

/** ZIP-225 wire format with empty Sapling and Orchard bundles. */
export function serializeTx(tx: TransparentTxV5): Uint8Array {
  const w = new Writer()
  w.u32(TX_VERSION_V5).u32(VERSION_GROUP_ID_V5).u32(tx.consensusBranchId >>> 0).u32(tx.lockTime).u32(tx.expiryHeight)
  writeTransparent(w, tx)
  w.compact(0) // nSpendsSapling
  w.compact(0) // nOutputsSapling (no valueBalanceSapling / anchor / proofs when both are zero)
  w.compact(0) // nActionsOrchard
  return w.finish()
}

/** Parse raw hex / bytes. Accepts v5 transactions whose shielded bundles are empty; anything else is refused by name. */
export function parseTx(raw: string | Uint8Array): TransparentTxV5 {
  const r = new Reader(typeof raw === 'string' ? hexToBytes(raw) : raw)
  const header = r.u32()
  const overwintered = (header & 0x80000000) !== 0
  const version = header & 0x7fffffff
  if (!overwintered || version !== 5) throw new Error(`Only v5 Zcash transactions are supported here (got version ${version}${overwintered ? '' : ', not overwintered'}).`)
  const vgid = r.u32()
  if (vgid !== VERSION_GROUP_ID_V5) throw new Error(`Unexpected version group id 0x${vgid.toString(16)} for a v5 transaction.`)
  const consensusBranchId = r.u32()
  const lockTime = r.u32()
  const expiryHeight = r.u32()
  const nIn = r.compact()
  const inputs: TxInput[] = []
  for (let i = 0; i < nIn; i++) {
    const txid = bytesToHex(reverseBytes(r.bytes(32)))
    const vout = r.u32()
    const scriptSig = r.varBytes()
    const sequence = r.u32()
    inputs.push({ txid, vout, scriptSig, sequence })
  }
  const nOut = r.compact()
  const outputs: TxOutput[] = []
  for (let i = 0; i < nOut; i++) outputs.push({ value: r.i64(), script: r.varBytes() })
  const nSpends = r.compact()
  const nOutputs = r.compact()
  if (nSpends !== 0 || nOutputs !== 0) throw new Error('This transaction carries a Sapling bundle; shielded transactions are not supported.')
  const nActions = r.compact()
  if (nActions !== 0) throw new Error('This transaction carries an Orchard bundle; shielded transactions are not supported.')
  if (r.remaining !== 0) throw new Error(`Trailing bytes after the transaction (${r.remaining}).`)
  return { consensusBranchId, lockTime, expiryHeight, inputs, outputs }
}

// ── ZIP-244 digests ──────────────────────────────────────────────────────────

function personal(tag: string): Uint8Array {
  const p = utf8ToBytes(tag)
  if (p.length !== 16) throw new Error(`BLAKE2b personalization must be 16 bytes: ${tag}`)
  return p
}

function h(tag: string | Uint8Array, data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32, personalization: typeof tag === 'string' ? personal(tag) : tag })
}

const EMPTY = new Uint8Array(0)

/** `ZcashTxHash_` ‖ consensus branch id (LE) — the personalization of both the txid and the signature digest. */
export function txHashPersonalization(consensusBranchId: number): Uint8Array {
  const p = new Uint8Array(16)
  p.set(utf8ToBytes('ZcashTxHash_'), 0)
  p.set(u32le(consensusBranchId >>> 0), 12)
  return p
}

export function headerDigest(tx: TransparentTxV5): Uint8Array {
  const w = new Writer().u32(TX_VERSION_V5).u32(VERSION_GROUP_ID_V5).u32(tx.consensusBranchId >>> 0).u32(tx.lockTime).u32(tx.expiryHeight)
  return h('ZTxIdHeadersHash', w.finish())
}

export function prevoutsDigest(tx: TransparentTxV5): Uint8Array {
  const w = new Writer()
  for (const i of tx.inputs) { assertTxid(i.txid); w.bytes(reverseBytes(hexToBytes(i.txid))).u32(i.vout) }
  return h('ZTxIdPrevoutHash', w.finish())
}

export function sequenceDigest(tx: TransparentTxV5): Uint8Array {
  const w = new Writer()
  for (const i of tx.inputs) w.u32(i.sequence)
  return h('ZTxIdSequencHash', w.finish())
}

export function outputsDigest(tx: TransparentTxV5): Uint8Array {
  const w = new Writer()
  for (const o of tx.outputs) w.i64(o.value).varBytes(o.script)
  return h('ZTxIdOutputsHash', w.finish())
}

/** T.2: hash of the three transparent digests; the hash of the empty string when there are no inputs AND no outputs. */
export function transparentDigest(tx: TransparentTxV5): Uint8Array {
  if (tx.inputs.length === 0 && tx.outputs.length === 0) return h('ZTxIdTranspaHash', EMPTY)
  const w = new Writer().bytes(prevoutsDigest(tx)).bytes(sequenceDigest(tx)).bytes(outputsDigest(tx))
  return h('ZTxIdTranspaHash', w.finish())
}

export const saplingDigestEmpty = (): Uint8Array => h('ZTxIdSaplingHash', EMPTY)
export const orchardDigestEmpty = (): Uint8Array => h('ZTxIdOrchardHash', EMPTY)

/** Non-malleable transaction id (ZIP-244 T.1 … T.4), internal byte order. */
export function txidDigest(tx: TransparentTxV5): Uint8Array {
  const w = new Writer().bytes(headerDigest(tx)).bytes(transparentDigest(tx)).bytes(saplingDigestEmpty()).bytes(orchardDigestEmpty())
  return h(txHashPersonalization(tx.consensusBranchId), w.finish())
}

/** Transaction id as explorers display it (byte-reversed hex). */
export function txid(tx: TransparentTxV5): string {
  return bytesToHex(reverseBytes(txidDigest(tx)))
}

/**
 * ZIP-244 S.2 transparent signature digest + S.1 … S.4 wrapper for SIGHASH_ALL
 * over input `index`. `spent[i]` is the output input `i` spends (value and
 * scriptPubKey are both committed to, so a lying transport cannot make us sign
 * for a different amount).
 */
export function sighashAll(tx: TransparentTxV5, index: number, spent: SpentOutput[]): Uint8Array {
  if (spent.length !== tx.inputs.length) throw new Error(`sighash: ${tx.inputs.length} inputs but ${spent.length} spent outputs`)
  const input = tx.inputs[index]
  const coin = spent[index]
  if (!input || !coin) throw new Error(`sighash: input ${index} does not exist`)
  const amounts = new Writer()
  const scripts = new Writer()
  for (const s of spent) { amounts.i64(s.value); scripts.varBytes(s.script) }
  const txin = new Writer().bytes(reverseBytes(hexToBytes(input.txid))).u32(input.vout).i64(coin.value).varBytes(coin.script).u32(input.sequence)
  const t = new Writer()
    .u8(SIGHASH_ALL)
    .bytes(prevoutsDigest(tx))
    .bytes(h('ZTxTrAmountsHash', amounts.finish()))
    .bytes(h('ZTxTrScriptsHash', scripts.finish()))
    .bytes(sequenceDigest(tx))
    .bytes(outputsDigest(tx))
    .bytes(h('Zcash___TxInHash', txin.finish()))
  const transparentSig = h('ZTxIdTranspaHash', t.finish())
  const w = new Writer().bytes(headerDigest(tx)).bytes(transparentSig).bytes(saplingDigestEmpty()).bytes(orchardDigestEmpty())
  return h(txHashPersonalization(tx.consensusBranchId), w.finish())
}

/** `<sig ‖ 0x01> <pubkey>` — the scriptSig of a P2PKH spend. */
export function p2pkhScriptSig(derSignature: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const sig = new Uint8Array(derSignature.length + 1)
  sig.set(derSignature, 0)
  sig[derSignature.length] = SIGHASH_ALL
  return new Writer().bytes(compactSize(sig.length)).bytes(sig).bytes(compactSize(publicKey.length)).bytes(publicKey).finish()
}

/** Split a P2PKH scriptSig back into DER signature (hash type stripped) and public key; undefined when it is not one. */
export function parseP2pkhScriptSig(scriptSig: Uint8Array): { signature: Uint8Array; hashType: number; publicKey: Uint8Array } | undefined {
  try {
    const r = new Reader(scriptSig)
    const sig = r.varBytes()
    const pub = r.varBytes()
    if (r.remaining !== 0 || sig.length < 9 || (pub.length !== 33 && pub.length !== 65)) return undefined
    return { signature: sig.slice(0, -1), hashType: sig[sig.length - 1]!, publicKey: pub }
  } catch { return undefined }
}

export { i64le }

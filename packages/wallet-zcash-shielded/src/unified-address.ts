import { blake2b } from '@noble/hashes/blake2.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bech32m, createBase58check } from '@scure/base'
import type { ZcashNetwork } from './types.js'

/**
 * Unified addresses (ZIP-316) read without the native SDK: which receivers an
 * address carries, and the t-address of its transparent receiver. The wallet
 * uses it to check what the SDK handed out (an Ironwood receiver is there, the
 * transparent receiver is the AWK t-address) instead of trusting a string.
 */

/** Receiver typecodes from ZIP-316. Anything else is reported by number. */
export const RECEIVER_TYPECODES = Object.freeze({ p2pkh: 0x00, p2sh: 0x01, sapling: 0x02, orchard: 0x03 } as const)

export type ReceiverKind = keyof typeof RECEIVER_TYPECODES | 'unknown'

export interface UnifiedReceiver {
  typecode: number
  /** Named for the four ZIP-316 typecodes; `unknown` for newer ones (a new pool's receiver, metadata items). */
  kind: ReceiverKind
  data: Uint8Array
}

export interface DecodedUnifiedAddress {
  network: ZcashNetwork
  /** In encoding order (ZIP-316 requires ascending typecodes). */
  receivers: UnifiedReceiver[]
}

const HRP: Record<ZcashNetwork, string> = { mainnet: 'u', testnet: 'utest' }
const T_PREFIX: Record<ZcashNetwork, { p2pkh: [number, number]; p2sh: [number, number] }> = {
  mainnet: { p2pkh: [0x1c, 0xb8], p2sh: [0x1c, 0xbd] },
  testnet: { p2pkh: [0x1d, 0x25], p2sh: [0x1c, 0xba] },
}
const b58check = createBase58check(sha256)

/** Read a unified address. Throws on a bad checksum, a bad padding, or an unknown HRP. */
export function decodeUnifiedAddress(address: string): DecodedUnifiedAddress {
  const { prefix, words } = bech32m.decode(address as `${string}1${string}`, false)
  const network = (Object.keys(HRP) as ZcashNetwork[]).find((n) => HRP[n] === prefix)
  if (!network) throw new Error(`Not a unified address (prefix "${prefix}").`)
  const jumbled = bech32m.fromWords(words)
  if (jumbled.length < 48 || jumbled.length > 4194368) throw new Error(`Unified address of impossible length ${jumbled.length}.`)
  const raw = f4jumbleInv(jumbled)
  const padding = hrpPadding(prefix)
  const tail = raw.subarray(raw.length - 16)
  if (!padding.every((b, i) => b === tail[i])) throw new Error('Unified address padding does not match its prefix.')
  const receivers: UnifiedReceiver[] = []
  const body = raw.subarray(0, raw.length - 16)
  let at = 0
  while (at < body.length) {
    const [typecode, n1] = readCompactSize(body, at)
    const [length, n2] = readCompactSize(body, at + n1)
    at += n1 + n2
    if (at + length > body.length) throw new Error('Unified address item runs past its end.')
    const kind = (Object.keys(RECEIVER_TYPECODES) as (keyof typeof RECEIVER_TYPECODES)[]).find((k) => RECEIVER_TYPECODES[k] === typecode) ?? 'unknown'
    receivers.push({ typecode, kind, data: body.slice(at, at + length) })
    at += length
  }
  return { network, receivers }
}

/** Encode receivers as a unified address (used by the tests; the wallet takes addresses from the SDK). */
export function encodeUnifiedAddress(network: ZcashNetwork, receivers: { typecode: number; data: Uint8Array }[]): string {
  const parts: number[] = []
  for (const r of [...receivers].sort((a, b) => a.typecode - b.typecode)) {
    parts.push(...writeCompactSize(r.typecode), ...writeCompactSize(r.data.length), ...r.data)
  }
  const raw = Uint8Array.from([...parts, ...hrpPadding(HRP[network])])
  return bech32m.encode(HRP[network], bech32m.toWords(f4jumble(raw)), false)
}

/** The t-address of the address's transparent receiver, or null when it has none. */
export function transparentReceiverAddress(decoded: DecodedUnifiedAddress): string | null {
  const r = decoded.receivers.find((x) => x.kind === 'p2pkh' || x.kind === 'p2sh')
  if (!r || r.data.length !== 20) return null
  const [a, b] = T_PREFIX[decoded.network][r.kind as 'p2pkh' | 'p2sh']
  return b58check.encode(Uint8Array.of(a, b, ...r.data))
}

// ── F4Jumble (ZIP-316) ────────────────────────────────────────────────────────

const H_LEN = 64

function hashH(i: number, u: Uint8Array, outLen: number): Uint8Array {
  return blake2b(u, { dkLen: outLen, personalization: personal('UA_F4Jumble_H', [i, 0, 0]) })
}

function hashG(i: number, u: Uint8Array, outLen: number): Uint8Array {
  const out = new Uint8Array(outLen)
  for (let j = 0; j * H_LEN < outLen; j++) {
    const block = blake2b(u, { dkLen: H_LEN, personalization: personal('UA_F4Jumble_G', [i, j & 0xff, j >> 8]) })
    out.set(block.subarray(0, Math.min(H_LEN, outLen - j * H_LEN)), j * H_LEN)
  }
  return out
}

function personal(tag: string, tail: number[]): Uint8Array {
  const p = new Uint8Array(16)
  for (let i = 0; i < tag.length; i++) p[i] = tag.charCodeAt(i)
  p.set(tail, tag.length)
  return p
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!
  return out
}

function split(m: Uint8Array): [Uint8Array, Uint8Array] {
  const left = Math.min(H_LEN, Math.floor(m.length / 2))
  return [m.subarray(0, left), m.subarray(left)]
}

export function f4jumble(m: Uint8Array): Uint8Array {
  const [a, b] = split(m)
  const x = xor(b, hashG(0, a, b.length))
  const y = xor(a, hashH(0, x, a.length))
  const d = xor(x, hashG(1, y, x.length))
  const c = xor(y, hashH(1, d, y.length))
  return Uint8Array.from([...c, ...d])
}

export function f4jumbleInv(m: Uint8Array): Uint8Array {
  const [c, d] = split(m)
  const y = xor(c, hashH(1, d, c.length))
  const x = xor(d, hashG(1, y, d.length))
  const a = xor(y, hashH(0, x, y.length))
  const b = xor(x, hashG(0, a, x.length))
  return Uint8Array.from([...a, ...b])
}

function hrpPadding(hrp: string): Uint8Array {
  const p = new Uint8Array(16)
  for (let i = 0; i < hrp.length; i++) p[i] = hrp.charCodeAt(i)
  return p
}

function readCompactSize(buf: Uint8Array, at: number): [number, number] {
  const first = buf[at]
  if (first === undefined) throw new Error('Unified address ends inside a length.')
  if (first < 0xfd) return [first, 1]
  if (first === 0xfd) {
    const v = buf[at + 1]! | (buf[at + 2]! << 8)
    if (v < 0xfd) throw new Error('Non-canonical compact size in a unified address.')
    return [v, 3]
  }
  if (first === 0xfe) {
    const v = (buf[at + 1]! | (buf[at + 2]! << 8) | (buf[at + 3]! << 16)) + buf[at + 4]! * 0x1000000
    if (v <= 0xffff) throw new Error('Non-canonical compact size in a unified address.')
    return [v, 5]
  }
  throw new Error('Unified address item too large.')
}

function writeCompactSize(n: number): number[] {
  if (n < 0xfd) return [n]
  if (n <= 0xffff) return [0xfd, n & 0xff, n >> 8]
  return [0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]
}

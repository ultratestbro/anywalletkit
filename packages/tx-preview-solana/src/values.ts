import { getBase64Decoder } from '@solana/kit'
import type { PreviewValue } from './types.js'

const base64 = getBase64Decoder()

/** Raw bytes as base64. */
export function toBase64(bytes: Uint8Array): string {
  return base64.decode(bytes)
}

/**
 * UTF-8 → string without `TextDecoder` (React Native's Hermes has none unless the app installs a polyfill). Strict:
 * overlong forms, surrogates and code points past U+10FFFF are invalid, and each invalid byte reads as one U+FFFD,
 * so data that is not clean text still shows, and shows that it is not.
 */
export function utf8ToString(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]!
    let cp = -1
    let len = 1
    if (b < 0x80) cp = b
    else if (b >= 0xc2 && b <= 0xdf) { len = 2; cp = b & 0x1f }
    else if (b >= 0xe0 && b <= 0xef) { len = 3; cp = b & 0x0f }
    else if (b >= 0xf0 && b <= 0xf4) { len = 4; cp = b & 0x07 }
    if (len > 1) {
      for (let k = 1; k < len; k++) {
        const c = bytes[i + k]
        if (c === undefined || (c & 0xc0) !== 0x80) { cp = -1; break }
        cp = (cp << 6) | (c & 0x3f)
      }
      const min = len === 2 ? 0x80 : len === 3 ? 0x800 : 0x10000
      if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = -1
    }
    if (cp < 0) { out += '�'; i += 1; continue }
    out += String.fromCodePoint(cp)
    i += len
  }
  return out
}

/**
 * Codama-generated decoders return options as `{__option: 'Some' | 'None'}`, data enums as `{__kind}`, bytes as
 * `Uint8Array` and a `discriminator` field per instruction. A preview wants plain data: options unwrapped (`None` →
 * `null`), `__kind` → `kind`, bytes → base64, discriminators dropped.
 */
export function toPreviewValue(value: unknown, depth = 0): PreviewValue {
  if (depth > 16) return null
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return value
  if (value instanceof Uint8Array) return toBase64(value)
  if (Array.isArray(value)) return value.map((v) => toPreviewValue(v, depth + 1))
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (o.__option === 'None') return null
    if (o.__option === 'Some') return toPreviewValue(o.value, depth + 1)
    const out: Record<string, PreviewValue> = {}
    for (const [k, v] of Object.entries(o)) {
      if (k === 'discriminator' || k.endsWith('Discriminator') || typeof v === 'function') continue
      out[k === '__kind' ? 'kind' : k] = toPreviewValue(v, depth + 1)
    }
    return out
  }
  return null
}

/** A decoded instruction data object's arguments (its fields, discriminators dropped). */
export function toArgs(data: unknown): Record<string, PreviewValue> {
  const v = toPreviewValue(data)
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, PreviewValue>) : {}
}

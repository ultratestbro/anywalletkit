import { getBase64Decoder } from '@solana/kit'
import type { PreviewValue } from './types.js'

const base64 = getBase64Decoder()

/** Raw bytes as base64. */
export function toBase64(bytes: Uint8Array): string {
  return base64.decode(bytes)
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

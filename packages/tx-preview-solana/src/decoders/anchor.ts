/**
 * A decoder for any Anchor program, driven by its IDL written as compact tables (`scripts/anchor-tables.mjs`
 * generates them from the on-chain IDL). Instructions match on their 8-byte discriminator, `emit_cpi!` events on the
 * event tag; arguments decode with `@solana/kit` codecs only, nothing Hermes lacks. Jupiter v6 and Kamino Lend use it.
 */
import {
  addDecoderSizePrefix, createDecoder, fixDecoderSize, getAddressDecoder, getArrayDecoder, getBooleanDecoder, getBytesDecoder,
  getI128Decoder, getI16Decoder, getI32Decoder, getI64Decoder, getI8Decoder, getNullableDecoder, getStructDecoder, getU128Decoder,
  getU16Decoder, getU32Decoder, getU64Decoder, getU8Decoder, transformDecoder, type Decoder, type ReadonlyUint8Array,
} from '@solana/kit'
import type { DecodedFields, InstructionDecoder, PreviewValue } from '../types.js'
import { toBase64, toPreviewValue } from '../values.js'

/** A Borsh type as an Anchor IDL spells it; `def` names an entry of the IDL's types. */
export type AnchorType =
  | 'u8' | 'u16' | 'u32' | 'u64' | 'u128' | 'i8' | 'i16' | 'i32' | 'i64' | 'i128' | 'bool' | 'pubkey' | 'bytes' | 'string'
  | { readonly def: string }
  | { readonly vec: AnchorType }
  | { readonly option: AnchorType }
  | { readonly array: AnchorType; readonly len: number }
export type AnchorField = readonly [name: string, type: AnchorType]
/** A struct, or an enum: variants in tag order, each with its fields (none for a unit variant). */
export type AnchorTypeDef =
  | { readonly struct: readonly AnchorField[] }
  | { readonly variants: ReadonlyArray<readonly [name: string, fields?: readonly AnchorField[]]> }
export type AnchorTypes = Readonly<Record<string, AnchorTypeDef>>
/** `[discriminator hex, Name, args, account names in order]`. */
export type AnchorInstruction = readonly [discriminator: string, name: string, args: readonly AnchorField[], accounts: readonly string[]]
/** `[discriminator hex, Name, fields]`. */
export type AnchorEvent = readonly [discriminator: string, name: string, fields: readonly AnchorField[]]

/**
 * An enum tag the IDL does not list: the program has grown a variant since the snapshot. Its payload size is unknown,
 * so nothing after it can be read — the decoder reports that instead of guessing a layout. Recognised by `name`, not
 * `instanceof`: an Error subclass does not survive every transpiler's class transform.
 */
const UNKNOWN_VARIANT = 'UnknownVariantError'
function unknownVariant(typeName: string, tag: number): Error {
  const error = new Error(`${typeName} variant ${tag} is not in the IDL this decoder was built from`)
  error.name = UNKNOWN_VARIANT
  return error
}

/**
 * An `emit_cpi!` event is a self-invocation whose data starts with this tag: Anchor's `EVENT_IX_TAG`, the u64
 * `0x1d9acb512ea545e4` (sha256("anchor:event")[0..8] read big-endian) written little-endian.
 */
export const ANCHOR_EVENT_IX_TAG = 'e445a52e51cb9a1d'

const HEX = '0123456789abcdef'
function hex8(data: Uint8Array, at: number): string {
  let s = ''
  for (let i = at; i < at + 8; i++) s += HEX[data[i]! >> 4]! + HEX[data[i]! & 15]!
  return s
}

/** Alignment padding carries nothing a reader needs. */
const PADDING = /^(padding\d*|endPadding)$/

/** Anchor `String`: shown as text when it is plain ASCII (no `TextDecoder` in Hermes), as base64 bytes otherwise. */
function asciiOrBase64(bytes: ReadonlyUint8Array): string {
  let s = ''
  for (const b of bytes) {
    if (b < 0x20 || b > 0x7e) return toBase64(bytes as Uint8Array)
    s += String.fromCharCode(b)
  }
  return s
}

const PRIMITIVES: Record<string, () => Decoder<unknown>> = {
  u8: getU8Decoder, u16: getU16Decoder, u32: getU32Decoder, u64: getU64Decoder, u128: getU128Decoder,
  i8: getI8Decoder, i16: getI16Decoder, i32: getI32Decoder, i64: getI64Decoder, i128: getI128Decoder,
  bool: getBooleanDecoder, pubkey: getAddressDecoder,
  bytes: () => addDecoderSizePrefix(getBytesDecoder(), getU32Decoder()),
  string: () => transformDecoder(addDecoderSizePrefix(getBytesDecoder(), getU32Decoder()), asciiOrBase64),
}

/** Kit decoders for one IDL's types, built on first use (the Jupiter `Swap` enum alone is 211 variants). */
class AnchorCodecs {
  private readonly cache = new Map<string, Decoder<unknown>>()
  private readonly built = new WeakMap<object, Decoder<unknown>>()
  constructor(private readonly types: AnchorTypes) {}

  of(t: AnchorType): Decoder<unknown> {
    const key = typeof t === 'string' ? undefined : t
    const hit = key ? this.built.get(key) : this.cache.get(`:${t as string}`)
    if (hit) return hit
    const made = this.make(t)
    if (key) this.built.set(key, made)
    else this.cache.set(`:${t as string}`, made)
    return made
  }

  private make(t: AnchorType): Decoder<unknown> {
    if (typeof t === 'string') {
      const make = PRIMITIVES[t]
      if (!make) throw new Error(`unknown primitive ${t}`)
      return make()
    }
    if ('def' in t) return this.named(t.def)
    if ('vec' in t) return getArrayDecoder(this.of(t.vec)) // Borsh Vec: u32 length prefix, kit's default
    if ('option' in t) return getNullableDecoder(this.of(t.option)) // Borsh Option: u8 tag, kit's default
    if (t.array === 'u8') return fixDecoderSize(getBytesDecoder(), t.len)
    return getArrayDecoder(this.of(t.array), { size: t.len })
  }

  struct(fields: readonly AnchorField[]): Decoder<Record<string, unknown>> {
    const inner = getStructDecoder(fields.map(([name, type]) => [name, this.of(type)] as const))
    if (!fields.some(([name]) => PADDING.test(name))) return inner as Decoder<Record<string, unknown>>
    return transformDecoder(inner, (value) => {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (!PADDING.test(k)) out[k] = v
      return out
    })
  }

  private named(name: string): Decoder<unknown> {
    const hit = this.cache.get(name)
    if (hit) return hit
    const def = this.types[name]
    if (!def) throw new Error(`IDL type ${name} is missing`)
    // A unit-only enum reads as its variant name; one with payloads as `{ kind, …fields }`.
    let built: Decoder<unknown>
    if ('struct' in def) built = this.struct(def.struct)
    else {
      const variants = def.variants
      const unitOnly = variants.every(([, fields]) => !fields?.length)
      const payloads = new Map<number, Decoder<Record<string, unknown>>>()
      const payload = (tag: number): Decoder<Record<string, unknown>> => {
        let d = payloads.get(tag)
        if (!d) payloads.set(tag, (d = this.struct(variants[tag]![1] ?? [])))
        return d
      }
      built = createDecoder<unknown>({
        read: (bytes, offset): [unknown, number] => {
          if (offset >= bytes.length) throw new RangeError(`${name}: data ends before the variant tag`)
          const tag = bytes[offset]!
          const variant = variants[tag]
          if (!variant) throw unknownVariant(name, tag)
          if (unitOnly) return [variant[0], offset + 1]
          const [fields, next] = payload(tag).read(bytes, offset + 1)
          return [{ kind: variant[0], ...fields }, next]
        },
      })
    }
    this.cache.set(name, built)
    return built
  }
}

/**
 * Read `fields` in order from `offset`. An enum tag the IDL does not know stops the read: that field and every one
 * after it are `null` and `partial` says why. Any other failure (data too short, a bad option tag) throws.
 */
function readFields(codecs: AnchorCodecs, fields: readonly AnchorField[], data: Uint8Array, offset: number): { args: Record<string, PreviewValue>; partial?: string } {
  const args: Record<string, PreviewValue> = {}
  let at = offset
  for (let i = 0; i < fields.length; i++) {
    const [name, type] = fields[i]!
    try {
      const [value, next] = codecs.of(type).read(data, at)
      args[name] = toPreviewValue(value)
      at = next
    } catch (error) {
      if (!(error instanceof Error) || error.name !== UNKNOWN_VARIANT) throw error
      for (const [rest] of fields.slice(i)) args[rest] = null
      return { args, partial: `${error.message}; ${fields.slice(i).map(([n]) => n).join(', ')} not decoded` }
    }
  }
  return { args }
}

/**
 * A decoder for an Anchor program from its IDL tables. Instructions match on their 8-byte discriminator; an
 * `emit_cpi!` event (the program invoking itself through its event authority) decodes as the event. Accounts are
 * named by position from the IDL (optional accounts the caller omits still hold their slot: Anchor passes the program
 * id there); accounts past the IDL's list (route hops, remaining accounts) stay unnamed.
 */
export function anchorDecoder(options: {
  programAddress: string
  programName: string
  instructions: readonly AnchorInstruction[]
  events?: readonly AnchorEvent[]
  types: AnchorTypes
}): InstructionDecoder {
  const { programAddress, programName, types } = options
  const instructions = new Map(options.instructions.map((ix) => [ix[0], ix]))
  const events = new Map((options.events ?? []).map((ev) => [ev[0], ev]))
  let codecs: AnchorCodecs | undefined
  return {
    programAddress,
    programName,
    decode(ix): DecodedFields | null {
      const { data } = ix
      if (data.length < 8) return null
      codecs ??= new AnchorCodecs(types)
      const disc = hex8(data, 0)
      if (disc === ANCHOR_EVENT_IX_TAG) {
        if (data.length < 16) return null
        const event = events.get(hex8(data, 8))
        if (!event) return null
        const accountNames = ix.accounts.map((_, i) => (i === 0 ? 'eventAuthority' : null))
        return { name: event[1], ...readFields(codecs, event[2], data, 16), accountNames }
      }
      const spec = instructions.get(disc)
      if (!spec) return null
      const [, name, args, accounts] = spec
      return { name, ...readFields(codecs, args, data, 8), accountNames: ix.accounts.map((_, i) => accounts[i] ?? null) }
    },
  }
}

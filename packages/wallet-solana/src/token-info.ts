import type { TokenFlag } from '@anywalletkit/core'
import { getUtf8Decoder } from '@solana/kit'

// Mint bytes → decimals, supply, authorities and the Token-2022 extensions a holder should know
// about. Pure functions over the account data, so the layouts are tested on real mainnet bytes.

/** Metaplex Token Metadata program: the metadata account of a legacy mint sits at its PDA. */
export const METAPLEX_METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'

const MINT_SIZE = 82
/** Token-2022 accounts with extensions: base data padded to 165 bytes, then the account type, then TLV. */
const ACCOUNT_TYPE_OFFSET = 165
const ACCOUNT_TYPE_MINT = 1
/** spl-token-2022 `ExtensionType` numbers (checked against @solana-program/token-2022). */
const EXT = { TransferFeeConfig: 1, DefaultAccountState: 6, NonTransferable: 9, PermanentDelegate: 12, TransferHook: 14, TokenMetadata: 19, PausableConfig: 26 } as const
const ACCOUNT_STATE_FROZEN = 2
const METAPLEX_KEY_METADATA_V1 = 4

/** What {@link parseMint} reads. `name` / `symbol` are set only when the Token-2022 metadata extension is present. */
export interface ParsedMint {
  decimals: number
  supply: bigint
  flags: TokenFlag[]
  name?: string
  symbol?: string
}

const isZero = (b: Uint8Array, at: number, len = 32): boolean => {
  for (let i = at; i < at + len; i++) if (b[i] !== 0) return false
  return true
}

const utf8 = getUtf8Decoder()

/** A borsh string (u32 length, UTF-8 bytes) at `at`, with Metaplex's trailing NUL padding removed; null when it runs past the buffer. */
function borshString(b: Uint8Array, at: number): { value: string; end: number } | null {
  if (at + 4 > b.length) return null
  const len = new DataView(b.buffer, b.byteOffset + at, 4).getUint32(0, true)
  const start = at + 4
  if (len > b.length - start) return null
  return { value: utf8.decode(b.subarray(start, start + len)).replace(/\0+$/, ''), end: start + len }
}

/**
 * Parse mint account data. `token2022` selects the layout rules: a legacy mint is exactly 82 bytes;
 * a Token-2022 mint is 82 bytes, or longer with account type 1 at byte 165 and extensions after it.
 * Returns null when the bytes are not an initialized mint. Extensions are read strictly within
 * bounds: a malformed entry ends the scan without failing the mint.
 */
export function parseMint(bytes: Uint8Array, token2022: boolean): ParsedMint | null {
  if (bytes.length < MINT_SIZE) return null
  if (!token2022 && bytes.length !== MINT_SIZE) return null
  if (token2022 && bytes.length !== MINT_SIZE && (bytes.length <= ACCOUNT_TYPE_OFFSET || bytes[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT)) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const mintAuthority = dv.getUint32(0, true)
  const freezeAuthority = dv.getUint32(46, true)
  if (mintAuthority > 1 || freezeAuthority > 1 || bytes[45] !== 1) return null
  const out: ParsedMint = { supply: dv.getBigUint64(36, true), decimals: bytes[44]!, flags: [] }
  if (mintAuthority === 1) out.flags.push('mint-authority')
  if (freezeAuthority === 1) out.flags.push('freeze-authority')
  if (token2022 && bytes.length > ACCOUNT_TYPE_OFFSET) readExtensions(bytes, ACCOUNT_TYPE_OFFSET + 1, out)
  return out
}

function readExtensions(b: Uint8Array, from: number, out: ParsedMint): void {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const flag = (f: TokenFlag) => { if (!out.flags.includes(f)) out.flags.push(f) }
  let at = from
  while (at + 4 <= b.length) {
    const type = dv.getUint16(at, true)
    const len = dv.getUint16(at + 2, true)
    if (type === 0) break // uninitialized: the rest is padding
    const start = at + 4
    if (len > b.length - start) break // malformed: stop reading, keep the mint
    const v = b.subarray(start, start + len)
    switch (type) {
      case EXT.TransferFeeConfig: {
        // authorities 32 + 32, withheld u64, older {epoch u64, max u64, bps u16}, newer {same}
        if (v.length >= 108) {
          const fv = new DataView(v.buffer, v.byteOffset, v.byteLength)
          if (fv.getUint16(88, true) > 0 || fv.getUint16(106, true) > 0) flag('transfer-fee')
        }
        break
      }
      case EXT.DefaultAccountState:
        if (v[0] === ACCOUNT_STATE_FROZEN) flag('default-frozen')
        break
      case EXT.NonTransferable:
        flag('non-transferable')
        break
      case EXT.PermanentDelegate:
        if (v.length >= 32 && !isZero(v, 0)) flag('permanent-delegate')
        break
      case EXT.TransferHook:
        if (v.length >= 64 && !isZero(v, 32)) flag('transfer-hook') // [authority, program id]
        break
      case EXT.PausableConfig:
        if (v.length >= 33 && (!isZero(v, 0) || v[32] === 1)) flag('pausable') // [authority, paused]
        break
      case EXT.TokenMetadata: {
        // update authority 32, mint 32, name, symbol, uri, additional metadata
        const name = borshString(v, 64)
        const symbol = name ? borshString(v, name.end) : null
        if (name && symbol) { out.name = name.value; out.symbol = symbol.value }
        break
      }
    }
    at = start + len
  }
}

/**
 * Name and symbol from a Metaplex metadata account (key 4 = MetadataV1, update authority, mint,
 * then borsh name / symbol / uri). Null when the bytes are not metadata for `mintBytes`.
 */
export function parseMetaplexMetadata(bytes: Uint8Array, mintBytes: Uint8Array): { name: string; symbol: string } | null {
  if (bytes.length < 65 + 8 || bytes[0] !== METAPLEX_KEY_METADATA_V1) return null
  for (let i = 0; i < 32; i++) if (bytes[33 + i] !== mintBytes[i]) return null
  const name = borshString(bytes, 65)
  const symbol = name ? borshString(bytes, name.end) : null
  return name && symbol ? { name: name.value, symbol: symbol.value } : null
}

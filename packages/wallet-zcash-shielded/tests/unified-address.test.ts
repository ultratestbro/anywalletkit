import { readFileSync } from 'node:fs'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { LocalSigner } from '@anywalletkit/core'
import { WalletManagerZcash, addressFor, encodeAddress } from '@anywalletkit/wallet-zcash'
import { decodeUnifiedAddress, encodeUnifiedAddress, f4jumble, f4jumbleInv, transparentReceiverAddress } from '../src/index.js'

// zcash/zcash-test-vectors (MIT OR Apache-2.0): test-vectors/json/{f4jumble,unified_address}.json
const load = (name: string) => (JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown[][]).slice(2)

describe('F4Jumble (ZIP-316 vectors)', () => {
  const vectors = load('f4jumble') as [string, string][]
  it.each(vectors.map(([normal, jumbled]) => [normal.length / 2, normal, jumbled]))('%i bytes: jumble and unjumble', (_len, normal, jumbled) => {
    expect(bytesToHex(f4jumble(hexToBytes(normal)))).toBe(jumbled)
    expect(bytesToHex(f4jumbleInv(hexToBytes(jumbled)))).toBe(normal)
  })
})

type UaVector = [string | null, string | null, string | null, string | null, number | null, string | null, string, string, number, number]

describe('unified addresses (ZIP-316 vectors)', () => {
  const vectors = load('unified_address') as UaVector[]

  it.each(vectors.map((v, i) => [i, v]))('vector %i decodes to its receivers and re-encodes', (_i, v) => {
    const [p2pkh, p2sh, sapling, orchard, unknownCode, unknownBytes, ua] = v
    const decoded = decodeUnifiedAddress(ua)
    expect(decoded.network).toBe('mainnet')
    const byKind = (k: string) => decoded.receivers.find((r) => r.kind === k)
    expect(byKind('p2pkh') ? bytesToHex(byKind('p2pkh')!.data) : null).toBe(p2pkh)
    expect(byKind('p2sh') ? bytesToHex(byKind('p2sh')!.data) : null).toBe(p2sh)
    expect(byKind('sapling') ? bytesToHex(byKind('sapling')!.data) : null).toBe(sapling)
    expect(byKind('orchard') ? bytesToHex(byKind('orchard')!.data) : null).toBe(orchard)
    const unknown = decoded.receivers.find((r) => r.kind === 'unknown')
    expect(unknown ? [unknown.typecode, bytesToHex(unknown.data)] : [null, null]).toEqual([unknownCode, unknownBytes])
    expect(encodeUnifiedAddress('mainnet', decoded.receivers)).toBe(ua)
  })

  it('names the transparent receiver as the t-address wallet-zcash encodes', () => {
    for (const v of vectors) {
      const decoded = decodeUnifiedAddress(v[6])
      const expected = v[0] ? encodeAddress('p2pkh', hexToBytes(v[0]), 'mainnet') : v[1] ? encodeAddress('p2sh', hexToBytes(v[1]), 'mainnet') : null
      expect(transparentReceiverAddress(decoded)).toBe(expected)
    }
  })

  it('the transparent receiver of account 0, diversifier 0 is the wallet-zcash account-0 key of the same seed', () => {
    // The vectors' root seeds are 32 bytes and WalletManager takes a 64-byte BIP-39 seed, so derive the
    // way WalletManagerZcash does (LocalSigner.leafFromSeed at basePath/0'/0/0) and encode with its addressFor.
    const v = vectors.find((x) => x[8] === 0 && x[9] === 0 && x[0] !== null)!
    expect(v).toBeDefined()
    expect(new WalletManagerZcash(new Uint8Array(64), { network: 'mainnet' }).basePath).toBe("m/44'/133'")
    const signer = LocalSigner.leafFromSeed(hexToBytes(v[7]), 'secp256k1', "m/44'/133'/0'/0/0")
    expect(addressFor(signer.publicKey, 'mainnet')).toBe(transparentReceiverAddress(decodeUnifiedAddress(v[6])))
    signer.dispose()
  })

  it('refuses a damaged address', () => {
    const ua = vectors[0]![6]
    const broken = ua.slice(0, 10) + (ua[10] === 'q' ? 'p' : 'q') + ua.slice(11)
    expect(() => decodeUnifiedAddress(broken)).toThrow()
    expect(() => decodeUnifiedAddress('t1QFUFYoKXSqa7c367ieJnuwHhsawVZtU1x')).toThrow()
  })
})

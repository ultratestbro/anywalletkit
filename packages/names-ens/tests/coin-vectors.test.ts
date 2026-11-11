import { describe, expect, it } from 'vitest'
import type { PublicClient } from 'viem'
import { NameError } from '@anywalletkit/core'
import { BTC_CAIP2, SOL_CAIP2, coinTypeFor, decodeBtcScript, ensResolver } from '../src/index.js'

/**
 * Known-answer vectors for the record encodings: a library bump (base58check, bech32, bech32m, sha256) must
 * not change a single address string. Sources: ENSIP-9 (Bitcoin scriptPubKey examples), BIP-173 (P2WSH),
 * BIP-350 (P2TR), ENSIP-11 (EVM coin types), Solana program ids.
 */
const bytes = (h: string) => Uint8Array.from((h.startsWith('0x') ? h.slice(2) : h).match(/.{2}/g)!, (b) => parseInt(b, 16))

const BTC_VECTORS: Array<[string, string, string]> = [
  // ENSIP-9
  ['P2PKH', '76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],
  ['P2SH', 'a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1887', '3Ai1JZ8pdJb2ksieUV8FsxSNVJCpoPi8W6'],
  ['P2WPKH', '0014751e76e8199196d454941c45d1b3a323f1433bd6', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'],
  // BIP-173
  ['P2WSH', '00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262', 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3'],
  // BIP-350
  ['P2TR', '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'],
]

const SOL_VECTORS: Array<[string, string]> = [
  ['0000000000000000000000000000000000000000000000000000000000000001', '11111111111111111111111111111112'],
  ['0761481d357474bb7c4d7624ebd3bdb3d8355e73d11043fc0da3538000000000', 'Vote111111111111111111111111111111111111111'],
  ['06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
]

function recordsClient(records: Record<string, string>) {
  return {
    getEnsAddress: async ({ name, coinType }: { name: string; coinType?: bigint }) => records[`${name}:${coinType ?? 60n}`] ?? null,
  } as unknown as PublicClient
}

describe('ENSIP-9 Bitcoin scriptPubKey → address', () => {
  for (const [kind, script, address] of BTC_VECTORS) {
    it(`${kind}`, () => {
      expect(decodeBtcScript(bytes(script), 'x')).toBe(address)
    })
  }

  it('the same vectors through resolve() (record bytes as the resolver returns them)', async () => {
    const records = Object.fromEntries(BTC_VECTORS.map(([kind, script]) => [`${kind.toLowerCase()}.eth:0`, `0x${script}`]))
    const r = ensResolver({ client: recordsClient(records) })
    for (const [kind, , address] of BTC_VECTORS) {
      expect((await r.resolve(`${kind.toLowerCase()}.eth`, BTC_CAIP2)).address).toBe(address)
    }
  })

  it('non-standard scripts are refused, not guessed', () => {
    // ENSIP-9's witness-v2 example (OP_2 + 16 bytes) and malformed lengths.
    for (const script of ['5210751e76e8199196d454941c45d1b3a323', '0014751e76e8199196d454941c45d1b3a323f1433b', '76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888', '5120' + '00'.repeat(31)]) {
      expect(() => decodeBtcScript(bytes(script), 'x')).toThrow(NameError)
    }
  })
})

describe('Solana record → base58 public key', () => {
  it('32-byte keys, leading zero bytes kept (an all-zero record means "no record")', async () => {
    const records = Object.fromEntries(SOL_VECTORS.map(([raw], i) => [`sol${i}.eth:501`, `0x${raw}`]))
    const r = ensResolver({ client: recordsClient(records) })
    for (const [i, [, address]] of SOL_VECTORS.entries()) {
      expect((await r.resolve(`sol${i}.eth`, SOL_CAIP2)).address).toBe(address)
    }
  })
})

describe('ENSIP-11 coin types', () => {
  it('0x80000000 | chainId for EVM chains other than mainnet', () => {
    expect(coinTypeFor('eip155:10')).toBe(2147483658n)
    expect(coinTypeFor('eip155:137')).toBe(2147483785n)
    expect(coinTypeFor('eip155:42161')).toBe(2147525809n)
    expect(coinTypeFor('eip155:0')).toBeNull()
    expect(coinTypeFor('eip155:2147483648')).toBeNull()
  })
})

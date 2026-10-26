import { describe, expect, it } from 'vitest'
import { getAddressEncoder, type Address } from '@solana/kit'
import { WalletAccountReadOnlySolana, type SolanaRpc } from '../src/index.js'

// Audit 2026-10-25 round 3, M1: an SPL transfer pays the owner of the token account it names. The
// kit's policies read that owner through getTokenAccountOwner; anything that is not an initialized
// Token / Token-2022 account answers undefined, and a network failure throws.

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const SYSTEM = '11111111111111111111111111111111'
const WALLET = '9bhvajVaz6ECMoa93J8p699zkrrH14hoTN1EcPVd1Pzp'
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const OWNER = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'
const TA = 'BQcdHdAQW1hczDbBi9hiegXPR7MzRYNM4gYHBJLjHCkS'

/** A token account's bytes: mint, owner, state at 108; `size` > 165 adds Token-2022's account-type byte at 165. */
function tokenAccount(o: { state?: number; size?: number; type?: number } = {}): string {
  const b = new Uint8Array(o.size ?? 165)
  b.set(getAddressEncoder().encode(MINT as Address), 0)
  b.set(getAddressEncoder().encode(OWNER as Address), 32)
  b[108] = o.state ?? 1
  if (b.length > 165) b[165] = o.type ?? 2
  return Buffer.from(b).toString('base64')
}

function account(served: Record<string, { owner: string; data: string } | null | 'error'>) {
  const calls: string[] = []
  const rpc = new Proxy({} as SolanaRpc, {
    get: (_t, m: string) => (...args: unknown[]) => ({
      send: async () => {
        if (m !== 'getAccountInfo') throw new Error(`unmocked ${m}`)
        const a = String(args[0])
        calls.push(a)
        const v = served[a]
        if (v === 'error') throw new Error('fetch failed')
        return { value: v ? { data: [v.data, 'base64'], owner: v.owner, executable: false, lamports: 1n, rentEpoch: 0n, space: 0n } : null }
      },
    }),
  })
  return { a: new WalletAccountReadOnlySolana(WALLET, { provider: rpc }), calls }
}

describe('getTokenAccountOwner', () => {
  it('Token and Token-2022 accounts (with extensions): the owner', async () => {
    expect(await account({ [TA]: { owner: TOKEN, data: tokenAccount() } }).a.getTokenAccountOwner(TA)).toBe(OWNER)
    expect(await account({ [TA]: { owner: TOKEN_2022, data: tokenAccount() } }).a.getTokenAccountOwner(TA)).toBe(OWNER)
    expect(await account({ [TA]: { owner: TOKEN_2022, data: tokenAccount({ size: 175 }) } }).a.getTokenAccountOwner(TA)).toBe(OWNER)
  })

  it('not an initialized token account: undefined', async () => {
    expect(await account({ [TA]: { owner: TOKEN_2022, data: tokenAccount({ size: 175, type: 1 }) } }).a.getTokenAccountOwner(TA)).toBeUndefined() // a mint with extensions
    expect(await account({ [TA]: { owner: TOKEN, data: tokenAccount({ state: 0 }) } }).a.getTokenAccountOwner(TA)).toBeUndefined()
    expect(await account({ [TA]: { owner: TOKEN, data: Buffer.from(new Uint8Array(82)).toString('base64') } }).a.getTokenAccountOwner(TA)).toBeUndefined() // a mint
    expect(await account({ [TA]: { owner: SYSTEM, data: tokenAccount() } }).a.getTokenAccountOwner(TA)).toBeUndefined() // a wallet
    expect(await account({ [TA]: null }).a.getTokenAccountOwner(TA)).toBeUndefined()
  })

  it('a malformed address is undefined without a network call; a network failure throws', async () => {
    const r = account({})
    expect(await r.a.getTokenAccountOwner('not-base58!')).toBeUndefined()
    expect(r.calls).toEqual([])
    await expect(account({ [TA]: 'error' }).a.getTokenAccountOwner(TA)).rejects.toThrow(/fetch failed/)
  })
})

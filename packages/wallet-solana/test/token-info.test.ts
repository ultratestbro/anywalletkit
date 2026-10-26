import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { NotATokenError } from '@anywalletkit/core'
import { getAddressEncoder, type Address } from '@solana/kit'
import { TOKEN_PROGRAM_ADDRESS, getMintEncoder } from '@solana-program/token'
import { TOKEN_2022_PROGRAM_ADDRESS, getMintEncoder as getMint2022Encoder } from '@solana-program/token-2022'
import { WalletAccountReadOnlySolana, type SolanaRpc } from '../src/index.js'
import { METAPLEX_METADATA_PROGRAM, parseMetaplexMetadata, parseMint } from '../src/token-info.js'

// Golden vectors: mainnet account bytes (test/fixtures/token-info.json), read through the same
// getAccountInfo path the account uses, plus crafted Token-2022 mints for the flags mainnet's
// big tokens do not carry.

const FIX = JSON.parse(readFileSync(new URL('./fixtures/token-info.json', import.meta.url), 'utf8')) as { accounts: Record<string, { owner: string; data: string } | null> }
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'
const WALLET = '9bhvajVaz6ECMoa93J8p699zkrrH14hoTN1EcPVd1Pzp'
const OTHER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as Address
const CRAFTED = 'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb'
const b64 = (u8: Uint8Array) => Buffer.from(u8).toString('base64')
const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

/** Accounts by address → a fake @solana/kit Rpc that serves getAccountInfo and records the calls. */
function account(accounts: Record<string, { owner: string; data: string } | null>) {
  const calls: string[] = []
  const rpc = new Proxy({} as SolanaRpc, {
    get: (_t, m: string) => (...args: unknown[]) => ({
      send: async () => {
        if (m !== 'getAccountInfo') throw new Error(`unmocked ${m}`)
        const a = String(args[0])
        calls.push(a)
        const v = accounts[a]
        return { value: v ? { data: [v.data, 'base64'], owner: v.owner, executable: false, lamports: 1n, rentEpoch: 0n, space: 0n } : null }
      },
    }),
  })
  return { a: new WalletAccountReadOnlySolana(WALLET, { provider: rpc }), calls }
}

const crafted2022 = (extensions: unknown[], extra: number[] = []) =>
  b64(new Uint8Array([...(getMint2022Encoder().encode({ mintAuthority: null, supply: 5n, decimals: 9, isInitialized: true, freezeAuthority: null, extensions } as never) as Uint8Array), ...extra]))

describe('getTokenInfo — mainnet bytes', () => {
  it('USDC: legacy mint, live mint + freeze authority, name and symbol from the Metaplex metadata account', async () => {
    const { a, calls } = account(FIX.accounts)
    const info = await a.getTokenInfo(USDC)
    expect(info).toMatchObject({ address: USDC, standard: 'spl', decimals: 6, symbol: 'USDC', name: 'USD Coin' })
    expect(info.flags).toEqual(['mint-authority', 'freeze-authority'])
    expect(info.totalSupply! > 10n ** 15n).toBe(true)
    expect(calls).toEqual([USDC, '5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq']) // the mint, then its metadata PDA
  })

  it('PYUSD: Token-2022, metadata from its own extension (no Metaplex read), permanent delegate flagged; 0 bps fee and a zero hook program are not', async () => {
    const { a, calls } = account(FIX.accounts)
    const info = await a.getTokenInfo(PYUSD)
    expect(info).toMatchObject({ address: PYUSD, standard: 'spl-token-2022', decimals: 6, symbol: 'PYUSD', name: 'PayPal USD' })
    expect(info.flags).toEqual(['mint-authority', 'freeze-authority', 'permanent-delegate'])
    expect(calls).toEqual([PYUSD])
  })

  it('a wallet, an unknown address, a malformed string: NotATokenError', async () => {
    const { a } = account(FIX.accounts)
    await expect(a.getTokenInfo(WALLET)).rejects.toThrow(NotATokenError)
    await expect(a.getTokenInfo(WALLET)).rejects.toThrow(/belongs to 11111111111111111111111111111111/)
    await expect(a.getTokenInfo(CRAFTED)).rejects.toThrow(/no account/)
    await expect(a.getTokenInfo('not-an-address')).rejects.toThrow(NotATokenError)
  })
})

describe('getTokenInfo — crafted mints', () => {
  it('Token-2022 flags: transfer fee > 0, non-transferable, default-frozen, transfer hook, pausable; a malformed trailing entry ends the scan', async () => {
    const data = crafted2022([
      { __kind: 'TransferFeeConfig', transferFeeConfigAuthority: OTHER, withdrawWithheldAuthority: OTHER, withheldAmount: 0n, olderTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 }, newerTransferFee: { epoch: 9n, maximumFee: 10n, transferFeeBasisPoints: 25 } },
      { __kind: 'NonTransferable' },
      { __kind: 'DefaultAccountState', state: 2 },
      { __kind: 'TransferHook', authority: OTHER, programId: OTHER },
      { __kind: 'PausableConfig', authority: { __option: 'Some', value: OTHER }, paused: false },
    ], [12, 0, 200, 0, 1, 2, 3]) // PermanentDelegate claiming 200 bytes it does not have
    const { a } = account({ [CRAFTED]: { owner: TOKEN_2022_PROGRAM_ADDRESS, data } })
    const info = await a.getTokenInfo(CRAFTED)
    expect(info.flags).toEqual(['transfer-fee', 'non-transferable', 'default-frozen', 'transfer-hook', 'pausable'])
    expect(info).toMatchObject({ decimals: 9, totalSupply: 5n, symbol: '', name: '' }) // no metadata anywhere
  })

  it('a permanent delegate of all zeroes and an empty pausable config are not flagged', () => {
    const data = bytes(crafted2022([
      { __kind: 'PermanentDelegate', delegate: '11111111111111111111111111111111' },
      { __kind: 'PausableConfig', authority: { __option: 'None' }, paused: false },
    ]))
    expect(parseMint(data, true)!.flags).toEqual([])
  })

  it('layout rules: a legacy mint is exactly 82 bytes, Token-2022 needs account type 1, uninitialized or bad option tags are not mints', () => {
    const legacy = getMintEncoder().encode({ mintAuthority: null, supply: 0n, decimals: 6, isInitialized: true, freezeAuthority: null }) as Uint8Array
    expect(parseMint(legacy, false)).toMatchObject({ decimals: 6, flags: [] })
    expect(parseMint(new Uint8Array([...legacy, ...new Uint8Array(83)]), false)).toBeNull() // 165 bytes: a token account's size
    const uninit = new Uint8Array(legacy); uninit[45] = 0
    expect(parseMint(uninit, false)).toBeNull()
    const badTag = new Uint8Array(legacy); badTag[0] = 7
    expect(parseMint(badTag, false)).toBeNull()
    const ext = bytes(crafted2022([{ __kind: 'NonTransferable' }]))
    const asAccount = new Uint8Array(ext); asAccount[165] = 2 // a Token-2022 token account
    expect(parseMint(asAccount, true)).toBeNull()
    expect(parseMint(ext.subarray(0, 120), true)).toBeNull()
  })

  it('a token-program account that is not a mint, and a metadata account owned by someone else, are handled', async () => {
    const tokenAccount = b64(new Uint8Array(165))
    const { a } = account({ [CRAFTED]: { owner: TOKEN_PROGRAM_ADDRESS, data: tokenAccount } })
    await expect(a.getTokenInfo(CRAFTED)).rejects.toThrow(/not an initialized mint/)
    const meta = FIX.accounts['5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq']!
    const spoofed = account({ ...FIX.accounts, '5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq': { owner: OTHER, data: meta.data } })
    expect(await spoofed.a.getTokenInfo(USDC)).toMatchObject({ symbol: '', name: '' })
  })

  it('Metaplex metadata must name the mint it is read for', () => {
    const meta = bytes(FIX.accounts['5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq']!.data)
    const usdc = getAddressEncoder().encode(USDC as Address) as Uint8Array
    expect(parseMetaplexMetadata(meta, usdc)).toEqual({ name: 'USD Coin', symbol: 'USDC' })
    expect(parseMetaplexMetadata(meta, getAddressEncoder().encode(PYUSD as Address) as Uint8Array)).toBeNull()
    expect(parseMetaplexMetadata(meta.subarray(0, 70), usdc)).toBeNull()
    expect(METAPLEX_METADATA_PROGRAM).toBe('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
  })
})

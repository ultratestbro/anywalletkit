import { describe, expect, it } from 'vitest'
import { getAddressEncoder, type Address } from '@solana/kit'
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token'
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022'
import { WalletAccountReadOnlySolana, type SolanaRpc } from '../src/index.js'

// Audit 2026-10-25 round 3, L10: getTokenBalances read legacy-program ATAs only, so a Token-2022
// balance showed 0; getTokenBalance fell back to the legacy program when reading the mint failed
// for any reason, a network error included, and answered 0 instead of failing.

const WALLET = '9bhvajVaz6ECMoa93J8p699zkrrH14hoTN1EcPVd1Pzp' as Address
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address // legacy mint
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo' as Address // Token-2022 mint

function tokenAccount(mint: Address, amount: bigint, size = 165): string {
  const b = new Uint8Array(size)
  b.set(getAddressEncoder().encode(mint), 0)
  b.set(getAddressEncoder().encode(WALLET), 32)
  new DataView(b.buffer).setBigUint64(64, amount, true)
  b[108] = 1
  if (size > 165) b[165] = 2
  return Buffer.from(b).toString('base64')
}

async function setup(fail: Set<string> = new Set()) {
  const [usdcAta] = await findAssociatedTokenPda({ owner: WALLET, mint: USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const [pyusdAta] = await findAssociatedTokenPda({ owner: WALLET, mint: PYUSD, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  const accounts: Record<string, { owner: string; data: string }> = {
    [USDC]: { owner: TOKEN_PROGRAM_ADDRESS, data: Buffer.alloc(82).toString('base64') },
    [PYUSD]: { owner: TOKEN_2022_PROGRAM_ADDRESS, data: Buffer.alloc(82).toString('base64') },
    [usdcAta]: { owner: TOKEN_PROGRAM_ADDRESS, data: tokenAccount(USDC, 7n) },
    [pyusdAta]: { owner: TOKEN_2022_PROGRAM_ADDRESS, data: tokenAccount(PYUSD, 9n, 175) },
  }
  const info = (a: string) => { const v = accounts[a]; return v ? { data: [v.data, 'base64'], owner: v.owner, executable: false, lamports: 1n, rentEpoch: 0n, space: 0n } : null }
  const rpc = new Proxy({} as SolanaRpc, {
    get: (_t, m: string) => (...args: unknown[]) => ({
      send: async () => {
        const a = String(args[0])
        if (m === 'getAccountInfo') { if (fail.has(a)) throw new Error('fetch failed'); return { value: info(a) } }
        if (m === 'getMultipleAccounts') return { value: (args[0] as string[]).map(info) }
        if (m === 'getTokenAccountBalance') { const v = accounts[a]; const u = v ? Uint8Array.from(Buffer.from(v.data, 'base64')) : undefined; return { value: { amount: u ? String(new DataView(u.buffer).getBigUint64(64, true)) : '0' } } }
        throw new Error(`unmocked ${m}`)
      },
    }),
  })
  return new WalletAccountReadOnlySolana(WALLET, { provider: rpc })
}

describe('token balances read both token programs and never hide a network error', () => {
  it('getTokenBalances: a Token-2022 balance is read, not 0', async () => {
    expect(await (await setup()).getTokenBalances([USDC, PYUSD])).toEqual({ [USDC]: 7n, [PYUSD]: 9n })
  })

  it('getTokenBalance: both programs; a network error reading the mint throws instead of answering 0', async () => {
    const a = await setup()
    expect(await a.getTokenBalance(USDC)).toBe(7n)
    expect(await a.getTokenBalance(PYUSD)).toBe(9n)
    await expect((await setup(new Set([PYUSD]))).getTokenBalance(PYUSD)).rejects.toThrow(/fetch failed/)
  })

  it('an address that is not a mint has a zero balance', async () => {
    expect(await (await setup()).getTokenBalance(WALLET)).toBe(0n)
  })
})

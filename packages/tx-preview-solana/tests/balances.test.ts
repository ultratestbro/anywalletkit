/**
 * Balance changes against what an explorer shows. `computeBalanceChanges` runs on each confirmed fixture's meta (the
 * same computation a simulation goes through) and must match an independent reading: the RPC's own jsonParsed
 * account list (`accountKeys`, not this package's lookup-table resolution) indexed into the meta's pre/post balances.
 * A few fixtures are also written out by hand, in the units an explorer's "Balance changes" table uses.
 */
import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { computeBalanceChanges, decodeTransaction } from '../src/index.js'
import { fixtureBalanceChanges, loadFixture, metaAccountKeys, type Fixture } from './helpers.js'

type WithKeys = Fixture & { accountKeys?: Array<{ pubkey: string }> }
const all = readdirSync(new URL('./fixtures/', import.meta.url))
  .flatMap((g) => readdirSync(new URL(`./fixtures/${g}/`, import.meta.url)).filter((f) => f.endsWith('.json')).map((f) => `${g}/${f}`))
const withKeys = all.filter((f) => (loadFixture(f) as WithKeys).accountKeys)

/** The signer's view rebuilt from scratch: lamports at its index, token amounts per mint over the accounts it owns. */
function independent(f: WithKeys) {
  const keys = f.accountKeys!.map((k) => k.pubkey)
  const signer = keys[0]!
  const sol = BigInt(f.meta.postBalances[0]!) - BigInt(f.meta.preBalances[0]!)
  type Entry = { pre?: bigint; post?: bigint; mint: string; owner: string | undefined; decimals: number }
  const byIndex = new Map<number, Entry>()
  for (const [side, list] of [['pre', f.meta.preTokenBalances], ['post', f.meta.postTokenBalances]] as const) {
    for (const t of list) {
      const e: Entry = byIndex.get(t.accountIndex) ?? { mint: t.mint, owner: t.owner, decimals: t.uiTokenAmount.decimals }
      e[side] = BigInt(t.uiTokenAmount.amount)
      e.owner ??= t.owner
      byIndex.set(t.accountIndex, e)
    }
  }
  const perMint = new Map<string, { decimals: number; delta: bigint }>()
  for (const e of byIndex.values()) {
    if (e.owner !== signer) continue
    const prev = perMint.get(e.mint)
    perMint.set(e.mint, { decimals: e.decimals, delta: (prev?.delta ?? 0n) + (e.post ?? 0n) - (e.pre ?? 0n) })
  }
  const tokens = [...perMint].filter(([, v]) => v.delta !== 0n).map(([mint, v]) => ({ mint, ...v })).sort((a, b) => a.mint.localeCompare(b.mint))
  const solChanges = keys.flatMap((k, i) => (f.meta.preBalances[i] !== f.meta.postBalances[i] ? [[k, BigInt(f.meta.postBalances[i]!) - BigInt(f.meta.preBalances[i]!)] as const] : []))
  return { signer, sol, tokens, solChanges }
}

describe('computeBalanceChanges on confirmed fixtures = the RPC\'s own balances', () => {
  it('covers the fixtures that carry the RPC account list', () => {
    expect(withKeys.length).toBeGreaterThanOrEqual(40)
  })

  it.each(withKeys)('%s', (file) => {
    const f = loadFixture(file) as WithKeys
    // The decoder's account resolution agrees with the RPC's (static keys, then loaded writable, then readonly).
    expect(metaAccountKeys(f)).toEqual(f.accountKeys!.map((k) => k.pubkey))
    const want = independent(f)
    const got = fixtureBalanceChanges(f)!
    expect(got.signer!.address).toBe(want.signer)
    expect(got.signer!.sol).toBe(want.sol)
    expect([...got.signer!.tokens].sort((a, b) => a.mint.localeCompare(b.mint))).toEqual(want.tokens)
    expect(got.sol.map((s) => [s.account, s.delta])).toEqual(want.solChanges)
    // The fee is inside the signer's SOL change: whatever else happened, it cannot be above minus the fee plus inflows.
    const inflow = got.sol.filter((s) => s.account !== want.signer && s.delta < 0n).reduce((a, s) => a - s.delta, 0n)
    expect(got.signer!.sol <= inflow - BigInt(f.meta.fee)).toBe(true)
  })
})

describe('by hand: what the explorer\'s balance-change table shows for the signer', () => {
  // Numbers below are read off each transaction's jsonParsed pre/post balances (the data Solana Explorer and Solscan
  // render in "Balance changes" / "Token balance change"), and the arithmetic is spelled out.

  it('Token-2022 TransferCheckedWithFee, PYUSD (iYFPsGn2…): -0.000019082 SOL (the fee), -1,960 PYUSD', () => {
    const b = fixtureBalanceChanges(loadFixture('token-2022/transfer-checked-with-fee.json'))!
    // fee 19,082 lamports = 5,000 base + ceil(4,694 CU × 3,000,000 µlamports / 10^6) = 5,000 + 14,082
    expect(b.signer).toEqual({ address: 'DCdxQDr1jUf8y1jP5bibG6bo2qQK3CfZavRtx9QQhCMg', sol: -19_082n, tokens: [{ mint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', decimals: 6, delta: -1_960_000_000n }] })
    // PYUSD's transfer fee is 0 bps: the recipient's account gets the whole 1,960.
    expect(b.tokens.map((t) => [t.owner, t.delta])).toEqual([['DCdxQDr1jUf8y1jP5bibG6bo2qQK3CfZavRtx9QQhCMg', -1_960_000_000n], ['CfgxJRYUE8cxjHPreb3GVxzCGh9t4fLWkSefZhiScQXK', 1_960_000_000n]])
  })

  it('Token-2022 Transfer into a new ATA (3MEDeDHP…): the recipient account counts from zero; rent + fee leave the signer', () => {
    const b = fixtureBalanceChanges(loadFixture('token-2022/transfer.json'))!
    // -2,095,080 = -(2,074,080 rent for the new token account + 21,000 fee)
    expect(b.signer!.sol).toBe(-(2_074_080n + 21_000n))
    expect(b.signer!.tokens).toEqual([{ mint: 'BKMp8wXfbsRjAQ65rpDgUPjL8s1xFDAtVWzw3eeQpump', decimals: 6, delta: -777_000_000n }])
    const created = b.tokens.find((t) => t.delta > 0n)!
    expect(created).toMatchObject({ pre: 0n, post: 777_000_000n, owner: 'WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc' })
  })

  it('rent reclaim, 15 token accounts closed (5SXN3yoS…): +0.02284512 SOL, closed accounts counted to zero', () => {
    const b = fixtureBalanceChanges(loadFixture('token-2022/rent-reclaim.json'))!
    // 10 × 1,513,840 + 1,620,520 + 2 × 1,488,440 + 2 × 1,559,560 = 22,854,920 rent back, minus the 9,800 fee
    expect(b.signer!.sol).toBe(10n * 1_513_840n + 1_620_520n + 2n * 1_488_440n + 2n * 1_559_560n - 9_800n)
    expect(b.signer!.tokens).toEqual([]) // every closed account was empty
    const closed = b.tokens.filter((t) => t.post === 0n)
    expect(closed).toHaveLength(15)
    expect(closed.every((t) => t.owner === b.signer!.address && t.pre === 0n && t.delta === 0n)).toBe(true)
  })

  it('wSOL wrap → close in one transaction (35JXm4Jn…): the token account never shows; all SOL leaves the signer', () => {
    const b = fixtureBalanceChanges(loadFixture('token/sync-native.json'))!
    // The temporary wSOL ATA is created, synced and closed inside the transaction: no token balance before or after.
    expect(b.tokens).toEqual([])
    // -217,735,221,385 = -(217,735,211,385 the close sends to FwWQqBgM… + 10,000 fee)
    expect(b.signer!.sol).toBe(-217_735_221_385n)
    expect(b.sol.find((s) => s.delta > 0n)).toMatchObject({ account: 'FwWQqBgMMVSVb3rNbbGoyKn11o6B5QnXeqHb1MXu4TqH', delta: 217_735_211_385n })
  })

  it('wSOL unwrap pays the fee exactly (2JBc9bPA…): signer SOL unchanged, +1,611 lamports of wSOL', () => {
    const b = fixtureBalanceChanges(loadFixture('token/unwrap-lamports.json'))!
    // UnwrapLamports 6,203 to the signer, TransferSol 1,203 out, fee 5,000: 6,203 - 1,203 - 5,000 = 0
    expect(b.signer!.sol).toBe(0n)
    expect(b.sol.some((s) => s.account === b.signer!.address)).toBe(false)
    expect(b.signer!.tokens).toEqual([{ mint: 'So11111111111111111111111111111111111111112', decimals: 9, delta: 1_611n }])
  })

  it('a plain v1 SOL transfer (65JEsrCU…): -0.000007288 SOL = 2,288 sent + 5,000 fee', () => {
    const b = fixtureBalanceChanges(loadFixture('system/transfer-sol-v1.json'))!
    expect(b.signer!.sol).toBe(-(2_288n + 5_000n))
    expect(b.sol.map((s) => s.delta)).toEqual([-7_288n, 2_288n])
  })
})

describe('computeBalanceChanges edge cases', () => {
  const keys = ['Signer1111111111111111111111111111111111111', 'Token11111111111111111111111111111111111111', 'Token21111111111111111111111111111111111111']
  const tb = (accountIndex: number, amount: string, owner = keys[0]!, mint = 'MintA111111111111111111111111111111111111111') => ({ accountIndex, mint, owner, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount, decimals: 6 } })

  it('returns null without pre/post balances', () => {
    expect(computeBalanceChanges(keys, { preBalances: null, postBalances: [1], preTokenBalances: [], postTokenBalances: [] })).toBeNull()
  })

  it('created (post only) and closed (pre only) token accounts count from and to zero; unchanged ones are left out', () => {
    const b = computeBalanceChanges(keys, {
      preBalances: [10n, 0n, 5n], postBalances: [10n, 0n, 5n],
      preTokenBalances: [tb(2, '40'), tb(1, '7', keys[0], 'MintB111111111111111111111111111111111111111')],
      postTokenBalances: [tb(1, '7', keys[0], 'MintB111111111111111111111111111111111111111')],
    }, keys[0])!
    expect(b.tokens.map((t) => [t.account, t.pre, t.post, t.delta])).toEqual([[keys[2], 40n, 0n, -40n]])
    expect(b.signer).toEqual({ address: keys[0], sol: 0n, tokens: [{ mint: 'MintA111111111111111111111111111111111111111', decimals: 6, delta: -40n }] })
  })

  it('sums several accounts of one mint for the signer and skips other owners', () => {
    const b = computeBalanceChanges(keys, {
      preBalances: [0, 0, 0], postBalances: [0, 0, 0],
      preTokenBalances: [tb(1, '10'), tb(2, '10', 'Other111111111111111111111111111111111111111')],
      postTokenBalances: [tb(1, '15'), tb(2, '0', 'Other111111111111111111111111111111111111111')],
    }, keys[0])!
    expect(b.signer!.tokens).toEqual([{ mint: 'MintA111111111111111111111111111111111111111', decimals: 6, delta: 5n }])
  })

  it('amounts above 2^64 stay exact (bigint end to end)', () => {
    const big = (1n << 70n) + 3n
    const b = computeBalanceChanges(keys, { preBalances: [big, 0n, 0n], postBalances: [1n, 0n, 0n], preTokenBalances: [tb(1, '0')], postTokenBalances: [tb(1, big.toString())] }, keys[0])!
    expect(b.signer!.sol).toBe(1n - big)
    expect(b.signer!.tokens[0]!.delta).toBe(big)
  })

  it('a key the caller could not resolve (null) is skipped, not mis-attributed', () => {
    const b = computeBalanceChanges([keys[0]!, null, keys[2]!], { preBalances: [5, 1, 1], postBalances: [4, 0, 2], preTokenBalances: [tb(1, '9')], postTokenBalances: [] }, keys[0])!
    expect(b.sol.map((s) => s.account)).toEqual([keys[0], keys[2]])
    expect(b.tokens).toEqual([])
  })

  it('without a signer: no signer view', () => {
    const f = loadFixture('token/transfer.json')
    const b = computeBalanceChanges(metaAccountKeys(f), { ...f.meta, preBalances: f.meta.preBalances.map(BigInt), postBalances: f.meta.postBalances.map(BigInt) })!
    expect(b.signer).toBeNull()
    expect(decodeTransaction(f.wire).feePayer).toBeTruthy()
  })
})

import { describe, expect, it } from 'vitest'
import type { ChainTx } from '@anywalletkit/core'
import { describeNativeStakeActivity } from '../src/index.js'

// Audit 2026-10-25 round 3, NS-5: a Withdraw to someone else's address read "Withdrew unstaked SOL"
// like a claim to the wallet, and an Authorize (a new staker / withdrawer for the stake account)
// read as a neutral "Stake account update".
const OWN = 'GAqiAFedTcbCRo2Xx6szdjo9z7bm3zDQwwEW5GkmBWzX'
const STRANGER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const STAKE = 'Stake11111111111111111111111111111111111111'
const ACCT = '7fUAJdStEuGbc3sM84cKRL6yYaaSstyLSU4ve5oovLS7'
const ctx = { own: new Set([OWN]) }
const tx = (parsed: { type: string; info: Record<string, unknown> }, transfers: ChainTx['transfers'] = []): ChainTx => ({
  chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', hash: '5'.repeat(88), time: 1, status: 'confirmed', address: OWN, from: OWN, to: STAKE, nativeValue: 0n, transfers,
  call: { to: STAKE, programs: [STAKE] },
  raw: { tx: { transaction: { message: { instructions: [{ program: 'stake', programId: STAKE, parsed }] } } } },
})

describe('native staking activity labels', () => {
  it('a withdraw to the wallet is a claim; to another address it says so', () => {
    const mine = describeNativeStakeActivity(tx({ type: 'withdraw', info: { stakeAccount: ACCT, destination: OWN, withdrawAuthority: OWN, lamports: 1_000_000_000 } }, [{ token: null, from: ACCT, to: OWN, amount: 1_000_000_000n }]), ctx)
    expect(mine).toMatchObject({ kind: 'claim', title: 'Withdrew unstaked SOL' })
    const away = describeNativeStakeActivity(tx({ type: 'withdraw', info: { stakeAccount: ACCT, destination: STRANGER, withdrawAuthority: OWN, lamports: 1_000_000_000 } }), ctx)
    expect(away?.title).toBe(`Withdrew unstaked SOL to ${STRANGER.slice(0, 4)}…${STRANGER.slice(-4)}`)
    expect(away?.subtitle).toMatch(/not one of your addresses/)
    expect(away?.counterparty).toBe(STRANGER)
  })

  it('an authorize is an authority change; a foreign new authority is flagged', () => {
    const toMe = describeNativeStakeActivity(tx({ type: 'authorize', info: { stakeAccount: ACCT, authority: OWN, newAuthority: OWN, authorityType: 'Staker' } }), ctx)
    expect(toMe?.title).toBe('Changed stake authority (staker)')
    expect(toMe?.subtitle).not.toMatch(/not one of your addresses/)
    const away = describeNativeStakeActivity(tx({ type: 'authorizeChecked', info: { stakeAccount: ACCT, authority: OWN, newAuthority: STRANGER, authorityType: 'Withdrawer' } }), ctx)
    expect(away?.title).toBe('Changed stake authority (withdrawer)')
    expect(away?.subtitle).toMatch(/new authority is not one of your addresses/)
    expect(away?.counterparty).toBe(STRANGER)
  })
})

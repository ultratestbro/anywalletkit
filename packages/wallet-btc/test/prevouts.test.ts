import { describe, expect, it } from 'vitest'
import { UnsafeTransactionError } from '../src/index.js'
import { ADDR0, ADDR1, PREV_A, PREV_B, TXID_A, TXID_B, fakeBlockbook, mk, prevTx } from './helpers.js'

/**
 * Scan 2026-10-23 F2: BIP-143 signs each p2wpkh input over its CLAIMED amount
 * only, so the wallet must authenticate every coin's amount against its full
 * previous transaction before signing — or a lying indexer can splice the
 * signatures of two sessions into a tx whose real fee nobody saw.
 */
const RECIPIENT = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l'

async function refusal(p: Promise<unknown>) {
  const e = await p.catch((err: unknown) => err)
  expect(e).toBeInstanceOf(UnsafeTransactionError)
  return e as UnsafeTransactionError
}

describe('p2wpkh coins are authenticated before signing (scan F2)', () => {
  it('an understated coin (the session-1 lie: B reported at 0.01 BTC) is refused and nothing is signed or sent', async () => {
    const f = fakeBlockbook({ utxos: [
      { txid: TXID_A, vout: 0, value: '100000', height: 1 },
      { txid: TXID_B, vout: 1, value: '1000', height: 1 }, // really 50 000
    ] })
    const a = await mk(f.fetchFn).getAccount(0)
    const e = await refusal(a.transfer({ recipient: RECIPIENT, amount: 99_000n }))
    expect(e.code).toBe('prevout-mismatch')
    expect(e.message).toMatch(/50000 sat on chain, not the 1000/)
    expect(f.sent).toHaveLength(0)
  })

  it('an overstated coin (the session-2 lie) is refused the same way', async () => {
    const f = fakeBlockbook({ utxos: [{ txid: TXID_A, vout: 0, value: '510000', height: 1 }] }) // really 100 000
    const a = await mk(f.fetchFn).getAccount(0)
    expect((await refusal(a.transfer({ recipient: RECIPIENT, amount: 200_000n }))).code).toBe('prevout-mismatch')
    expect(f.sent).toHaveLength(0)
  })

  it('a previous transaction that does not hash to the claimed txid is refused', async () => {
    const forged = prevTx([[ADDR0, 900_000n]], 9) // pays more, but has another id
    const f = fakeBlockbook({
      utxos: [{ txid: TXID_A, vout: 0, value: '900000', height: 1 }],
      override: (path) => (path === `/api/v2/tx/${TXID_A}` ? { txid: TXID_A, blockHeight: 1, confirmations: 9, hex: forged.hex } : undefined),
    })
    const a = await mk(f.fetchFn).getAccount(0)
    const e = await refusal(a.transfer({ recipient: RECIPIENT, amount: 10_000n }))
    expect(e.message).toMatch(/hashes to/)
    expect(f.sent).toHaveLength(0)
  })

  it('a coin whose output pays another script is refused', async () => {
    const f = fakeBlockbook({ utxos: [{ txid: TXID_B, vout: 0, value: '7777', height: 1 }] }) // PREV_B:0 pays ADDR1
    const a = await mk(f.fetchFn).getAccount(0)
    expect((await refusal(a.transfer({ recipient: RECIPIENT, amount: 1_000n }))).message).toMatch(/does not pay this account/)
  })

  it('honest coins still spend, each previous transaction fetched once', async () => {
    const f = fakeBlockbook()
    const a = await mk(f.fetchFn).getAccount(0)
    await a.transfer({ recipient: RECIPIENT, amount: 120_000n })
    expect(f.sent).toHaveLength(1)
    expect(f.calls.filter((c) => c === `/api/v2/tx/${PREV_A.id}`)).toHaveLength(1)
    expect(f.calls.filter((c) => c === `/api/v2/tx/${PREV_B.id}`)).toHaveLength(1)
    void ADDR1
  })
})

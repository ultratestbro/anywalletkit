import { describe, expect, it } from 'vitest'
import { ADDR0, ADDR1, fakeBlockbook, mk } from './helpers.js'

// Audit 2026-10-25 round 3, L9: outputs were matched to the recipient and to our change by address
// string. A transfer to oneself made the recipient output "change" (then "recipient missing"), and a
// recipient written in uppercase bech32 (valid, same script) matched nothing: both were refused at
// signing. Outputs are now matched by scriptPubKey, the recipient first.

describe('BTC outputs are matched by script', () => {
  it('a transfer to oneself is signed: one recipient output and the change', async () => {
    const f = fakeBlockbook()
    const a = await mk(f.fetchFn).getAccount(0)
    const res = await a.transfer({ recipient: ADDR0, amount: 10_000n })
    expect(res.hash).toMatch(/^[0-9a-f]{64}$/)
    const d = await a.describeTransaction({ to: ADDR0, value: 10_000n })
    expect(d.outputs.map((o) => o.role)).toEqual(['recipient', 'change'])
  })

  it('an uppercase bech32 recipient is the same output', async () => {
    const f = fakeBlockbook()
    const a = await mk(f.fetchFn).getAccount(0)
    await expect(a.transfer({ recipient: ADDR1.toUpperCase(), amount: 10_000n })).resolves.toMatchObject({ hash: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })
})

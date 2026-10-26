import { describe, expect, it } from 'vitest'
import { fakeBlockchair, mk } from './helpers.js'

// Audit 2026-10-25 round 3, L9: outputs were matched by address string, so a transfer to oneself
// made the recipient output "change" and was refused. Outputs are now matched by script, recipient first.

describe('Zcash outputs are matched by script', () => {
  it('a transfer to oneself is signed: one recipient output and the change', async () => {
    const f = fakeBlockchair()
    const a = await mk(f.fetchFn).getAccount(0)
    const me = await a.getAddress()
    await expect(a.transfer({ recipient: me, amount: 60_000_000n })).resolves.toMatchObject({ hash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    const d = await a.describeTransaction({ to: me, value: 60_000_000n })
    expect(d.outputs.map((o) => o.role)).toEqual(['recipient', 'change'])
  })
})

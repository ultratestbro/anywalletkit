import { describe, expect, it, vi } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { applyPolicies, type WriteIntent } from '../src/index.js'

// A raw send signs `value`: the amount confirm sees is read from `value` alone. An `amount` next to it
// that says something else makes the amount unknown, and a value too long to read is unknown too.
const TO = '0x00000000000000000000000000000000000a110e'
const BTC = 'bitcoin:000000000019d6689c085ae165831e93'
const BTC_TO = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'
const ZEC_TO = 't1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua'
const ONE_ETH = 10n ** 18n

async function seen(chain: string, method: 'sendTransaction' | 'signTransaction', tx: unknown): Promise<WriteIntent> {
  const confirm = vi.fn(async (_i: WriteIntent) => true)
  const g = applyPolicies(createMockAccount({ chain, address: 'me' }), { confirm }) as unknown as Record<string, (tx: unknown) => Promise<unknown>>
  await g[method]!(tx)
  return confirm.mock.calls[0]![0]
}

describe('raw sends: the amount is the value that is signed', () => {
  const cases: Array<[string, string]> = [['eip155:1', TO], [BTC, BTC_TO], ['zcash:mainnet', ZEC_TO]]

  it('an `amount` that differs from `value` leaves the amount unknown (EVM, Bitcoin, Zcash)', async () => {
    for (const [chain, to] of cases) {
      for (const method of ['sendTransaction', 'signTransaction'] as const) {
        expect((await seen(chain, method, { to, value: ONE_ETH, amount: 1n })).amount).toBeUndefined()
        expect((await seen(chain, method, { to, value: ONE_ETH, amount: 'one' })).amount).toBeUndefined()
      }
    }
  })

  it('an `amount` alone is not what the transaction pays', async () => {
    for (const [chain, to] of cases) expect((await seen(chain, 'sendTransaction', { to, amount: ONE_ETH })).amount).toBeUndefined()
  })

  it('a value string longer than the policies read is an unknown amount', async () => {
    const padded = '0'.repeat(301) + '1'
    for (const [chain, to] of cases) expect((await seen(chain, 'sendTransaction', { to, value: padded })).amount).toBeUndefined()
  })

  it('control: value alone, or with the same amount, is the amount; a transfer still reads `amount`', async () => {
    for (const [chain, to] of cases) {
      expect((await seen(chain, 'sendTransaction', { to, value: ONE_ETH })).amount).toBe(ONE_ETH)
      expect((await seen(chain, 'sendTransaction', { to, value: '1000000000000000000', amount: ONE_ETH })).amount).toBe(ONE_ETH)
    }
    const confirm = vi.fn(async (_i: WriteIntent) => true)
    const g = applyPolicies(createMockAccount({ chain: 'eip155:1', address: 'me' }), { confirm }) as unknown as { transfer: (o: unknown) => Promise<unknown> }
    await g.transfer({ recipient: TO, amount: ONE_ETH })
    expect(confirm.mock.calls[0]![0]).toMatchObject({ to: TO, amount: ONE_ETH })
  })
})

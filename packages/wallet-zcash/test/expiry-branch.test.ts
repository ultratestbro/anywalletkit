import { describe, expect, it } from 'vitest'
import { MAINNET_UPGRADES, WalletManagerZcash, parseTx } from '../src/index.js'
import { SEED, fakeBlockchair, mk } from './helpers.js'

// Audit 2026-10-25 round 3, L7: with the chain tip unavailable, a transaction was signed with
// expiry 0 (never expires); the branch id was taken for the tip, not for the next block the
// transaction lands in; testnet / regtest used the mainnet upgrade table. Now: no tip, no
// signature (when expiry, anti-fee-sniping or the branch id need it); expiry = tip + 1 + delta;
// the branch id is the one in force at tip + 1; off mainnet the branch id must be configured.

const RECIPIENT = 't1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua'

describe('Zcash expiry and branch id', () => {
  it('no chain tip: nothing is signed', async () => {
    const f = fakeBlockchair({ override: (path) => (path.startsWith('stats') ? { nope: 1 } : undefined) })
    await expect((await mk(f.fetchFn).getAccount(0)).transfer({ recipient: RECIPIENT, amount: 60_000_000n })).rejects.toThrow(/tip/)
    expect(f.sent).toHaveLength(0)
  })

  it('expiry = tip + 1 + delta; the branch id is the one at tip + 1', async () => {
    const nu63 = MAINNET_UPGRADES.at(-1)!
    const f = fakeBlockchair({ tip: nu63.height - 1 })
    await (await mk(f.fetchFn).getAccount(0)).transfer({ recipient: RECIPIENT, amount: 60_000_000n })
    const tx = parseTx(f.sent[0]!)
    expect(tx.expiryHeight).toBe(nu63.height - 1 + 1 + 40)
    expect(tx.consensusBranchId).toBe(nu63.branchId)
  })

  it('off mainnet the branch id must be configured', async () => {
    const f = fakeBlockchair()
    const t = new WalletManagerZcash(SEED, { network: 'testnet', client: { type: 'blockchair' }, fetch: f.fetchFn })
    const a = await t.getAccount(0)
    const me = await a.getAddress()
    await expect(a.transfer({ recipient: me, amount: 60_000_000n })).rejects.toMatchObject({ code: 'unknown-branch-id' })
    const configured = await new WalletManagerZcash(SEED, { network: 'testnet', client: { type: 'blockchair' }, fetch: f.fetchFn, consensusBranchId: 0x4dec4df0 }).getAccount(0)
    await configured.transfer({ recipient: me, amount: 60_000_000n })
    expect(parseTx(f.sent.at(-1)!).consensusBranchId).toBe(0x4dec4df0)
  })
})

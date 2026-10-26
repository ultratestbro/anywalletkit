import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { applyPolicies } from '../src/index.js'

// Audit 2026-10-25 round 3, H4: rule keys were matched by string. Rules written with the catalog
// spelling of a network (`solana:mainnet`, `tron:728126428`, `bitcoin:mainnet` — the ids AGENTS.md
// points apps at) were silently skipped for accounts that report the genesis form, and the
// `bitcoin` namespace never matched `bip122` accounts.
const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const TRON = 'tron:0x2b6653dc'
const BTC = 'bip122:000000000019d6689c085ae165831e93'
const SOL_DRAINER = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'
const TRON_DRAINER = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'
const BTC_DRAINER = 'bc1qdrainer'
const OK = 'bc1qfriend'

describe('policy keys in another spelling of the same network', () => {
  it.each([
    [SOL, 'solana:mainnet', SOL_DRAINER],
    [TRON, 'tron:728126428', TRON_DRAINER],
    [TRON, 'tron:mainnet', TRON_DRAINER],
    [TRON, 'tron:0x2B6653DC', TRON_DRAINER],
    [BTC, 'bitcoin:mainnet', BTC_DRAINER],
    [BTC, 'bitcoin', BTC_DRAINER],
    ['eip155:1', 'eip155:0x1', '0x000000000000000000000000000000000000dEaD'],
  ])('account %s, rules keyed %s: blocklist and maxFee apply', async (chain, key, drainer) => {
    const acc = createMockAccount({ chain, fee: 10n ** 9n })
    await expect(applyPolicies(acc, { blocklist: { [key]: [drainer] } }, chain).transfer({ recipient: drainer, amount: 1n })).rejects.toMatchObject({ policy: 'blocklist' })
    await expect(applyPolicies(acc, { maxFee: { [key]: 1n } }, chain).transfer({ recipient: drainer, amount: 1n })).rejects.toMatchObject({ policy: 'maxFee' })
    // without `chain`, the account's own id is the one judged
    await expect(applyPolicies(acc, { blocklist: { [key]: [drainer] } }).transfer({ recipient: drainer, amount: 1n })).rejects.toMatchObject({ policy: 'blocklist' })
    expect(acc.sent).toHaveLength(0)
  })

  it('an allowlist under the other spelling holds too, and another network\'s rules do not apply', async () => {
    const acc = createMockAccount({ chain: BTC, fee: 1n })
    await expect(applyPolicies(acc, { allowlist: { 'bitcoin:mainnet': [OK] } }, BTC).transfer({ recipient: BTC_DRAINER, amount: 1n })).rejects.toMatchObject({ policy: 'allowlist' })
    await applyPolicies(acc, { allowlist: { 'bitcoin:mainnet': [OK] } }, BTC).transfer({ recipient: OK, amount: 1n })
    // testnet's rules are not mainnet's
    await applyPolicies(acc, { blocklist: { 'bitcoin:testnet': [BTC_DRAINER] }, maxFee: { 'tron:mainnet': 0n } }, BTC).transfer({ recipient: BTC_DRAINER, amount: 1n })
    expect(acc.sent).toHaveLength(2)
  })
})

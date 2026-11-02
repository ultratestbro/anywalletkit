import { describe, expect, it, vi } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { PolicyViolationError, applyPolicies, type WriteIntent } from '../src/index.js'

// A write given as a list that also carries named fields (`Object.assign([call], { to, value })`):
// the elements and the named fields are two different writes, so no destination is known.
const ALLOWED = '0x00000000000000000000000000000000000a110e'
const OTHER = '0x00000000000000000000000000000000000e0e01'
const NFT = '0x00000000000000000000000000000000000000f7'
const BTC_OK = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'
const BTC_OTHER = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const ZERO = '0'.repeat(64)
const account = (chain: string) => createMockAccount({ chain, address: 'me' })

describe('EVM: a list with named fields', () => {
  const shaped = () => Object.assign([{ to: ALLOWED, value: 0n }], { to: OTHER, value: 10n ** 18n, chainId: 1 })

  it('the allowlist refuses it, the blocklist refuses it without confirm, confirm sees destinationUnknown', async () => {
    await expect(applyPolicies(account('eip155:1'), { allowlist: { 'eip155:1': [ALLOWED] } }).sendTransaction(shaped())).rejects.toMatchObject({ policy: 'allowlist' })
    await expect(applyPolicies(account('eip155:1'), { blocklist: { 'eip155:1': [OTHER] } }).sendTransaction(shaped())).rejects.toBeInstanceOf(PolicyViolationError)
    await expect(applyPolicies(account('eip155:1'), { blocklist: { 'eip155:1': [OTHER] } }).signTransaction(shaped() as never)).rejects.toBeInstanceOf(PolicyViolationError)
    const confirm = vi.fn(async (_i: WriteIntent) => false)
    await expect(applyPolicies(account('eip155:1'), { confirm }).sendTransaction(shaped())).rejects.toThrow(/not confirmed/)
    expect(confirm.mock.calls[0]![0]).toMatchObject({ kind: 'send', destinationUnknown: true, to: OTHER })
  })

  it('a revoke-shaped list with named fields is not a revoke (the allowlist still applies)', async () => {
    const clear = { to: NFT, value: 0n, data: `0x095ea7b3${ZERO}${'0'.repeat(63)}5` }
    const plain = applyPolicies(account('eip155:1'), { allowlist: { 'eip155:1': [ALLOWED] } })
    // control: the plain one-call list is a revoke, the allowlist does not apply to it
    expect(await plain.sendTransaction([clear])).toMatchObject({ hash: expect.any(String) })
    await expect(plain.sendTransaction(Object.assign([clear], { to: OTHER, value: 1n }))).rejects.toMatchObject({ policy: 'allowlist' })
  })

  it('control: a plain list of calls (a batching account) is still read call by call', async () => {
    const allow = applyPolicies(account('eip155:1'), { allowlist: { 'eip155:1': [ALLOWED] } })
    expect(await allow.sendTransaction([{ to: ALLOWED }, { to: ALLOWED, value: 1n }])).toMatchObject({ hash: expect.any(String) })
    await expect(allow.sendTransaction([{ to: ALLOWED }, { to: OTHER }])).rejects.toMatchObject({ policy: 'allowlist' })
  })
})

describe('Bitcoin / Zcash: a spend is one object, never a list', () => {
  it('a list is unknown whatever its elements say; the one-object spend is read off `to`', async () => {
    const shaped = Object.assign([{ to: BTC_OK, value: 1n }], { to: BTC_OTHER, value: 10n ** 8n })
    const allow = applyPolicies(account('bip122:000000000019d6689c085ae165831e93'), { allowlist: { 'bip122:000000000019d6689c085ae165831e93': [BTC_OK] } })
    await expect(allow.sendTransaction(shaped)).rejects.toMatchObject({ policy: 'allowlist' })
    await expect(allow.sendTransaction([{ to: BTC_OK, value: 1n }])).rejects.toMatchObject({ policy: 'allowlist' })
    expect(await allow.sendTransaction({ to: BTC_OK, value: 1n })).toMatchObject({ hash: expect.any(String) })
    const block = applyPolicies(account('bip122:000000000019d6689c085ae165831e93'), { blocklist: { 'bip122:000000000019d6689c085ae165831e93': [BTC_OTHER] } })
    await expect(block.sendTransaction(shaped)).rejects.toBeInstanceOf(PolicyViolationError)
    const zcash = applyPolicies(account('zcash:mainnet'), { allowlist: { 'zcash:mainnet': ['t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua'] } })
    await expect(zcash.sendTransaction(Object.assign([{ to: 't1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua', value: 1n }], { to: 't1other', value: 1n }))).rejects.toMatchObject({ policy: 'allowlist' })
  })

  it('TON keeps reading every message of a list (wallet-ton sends the elements)', async () => {
    const to = `0:${'11'.repeat(32)}`
    const allow = applyPolicies(account('ton:-239'), { allowlist: { 'ton:-239': [to] } })
    expect(await allow.sendTransaction([{ to, value: 1n }])).toMatchObject({ hash: expect.any(String) })
  })
})

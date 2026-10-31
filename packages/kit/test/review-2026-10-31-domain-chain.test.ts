import { describe, expect, it, vi } from 'vitest'
// wallet-evm is not a kit devDependency; its built dist is imported by path (offline: no provider, chainId fixed).
import { WalletManagerEvm } from '../../wallet-evm/dist/index.js'
import { PolicyViolationError, Wallet, type Policies, type WriteIntent } from '../src/index.js'

// Typed data whose EIP-712 domain is another chain than the account's (signed with allowCrossChainTypedData)
// is judged by the domain chain's rules as well, and confirm sees that chain as `domainChain`.

const SEED = 'test test test test test test test test test test test junk'
const CHAIN = 'eip155:1'
const POLYGON = 'eip155:137'
const TOKEN = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
const SPENDER = '0xa77ac3e5a77ac3e5a77ac3e5a77ac3e5a77ac3e5'
const DOMAIN_TYPE = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }]

const permit = (owner: string, chainId: unknown) => ({
  domain: { name: 'USD Coin', version: '2', chainId, verifyingContract: TOKEN },
  primaryType: 'Permit',
  types: { EIP712Domain: DOMAIN_TYPE, Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  message: { owner, spender: SPENDER, value: 10n ** 12n, nonce: 0n, deadline: 9_999_999_999n },
})

async function account(policies: Policies, allowCrossChainTypedData: boolean) {
  const w = new Wallet(SEED, { policies })
  w.registerWallet(CHAIN, WalletManagerEvm as never, { chainId: 1, allowCrossChainTypedData })
  return (await w.getAccount(CHAIN)) as unknown as { getAddress(): Promise<string>; signTypedData(t: unknown): Promise<string> }
}

describe('typed data: the domain chain rules apply too', () => {
  it('control: blocklist under the account chain refuses the spender', async () => {
    const acc = await account({ blocklist: { [CHAIN]: [SPENDER] } }, true)
    await expect(acc.signTypedData(permit(await acc.getAddress(), 137))).rejects.toThrow(/blocklist/)
  })

  it('control: default config still refuses a foreign domain', async () => {
    const acc = await account({ blocklist: { [POLYGON]: [SPENDER] } }, false)
    await expect(acc.signTypedData(permit(await acc.getAddress(), 137))).rejects.toThrow()
  })

  it('blocklist under the domain chain (137) refuses the spender of a Polygon Permit', async () => {
    const confirm = vi.fn(async () => true)
    const acc = await account({ blocklist: { [POLYGON]: [SPENDER] }, confirm }, true)
    await expect(acc.signTypedData(permit(await acc.getAddress(), 137))).rejects.toThrow(/eip155:137 blocklist/)
    expect(confirm).not.toHaveBeenCalled()
  })

  it.each([['0x89'], ['137'], [137n]])('domain chainId %s is read the same way', async (id) => {
    const acc = await account({ blocklist: { [POLYGON]: [SPENDER] } }, true)
    await expect(acc.signTypedData(permit(await acc.getAddress(), id))).rejects.toThrow(/blocklist/)
  })

  it('a malformed domain chainId is refused', async () => {
    const acc = await account({ blocklist: { [POLYGON]: [SPENDER] } }, true)
    await expect(acc.signTypedData(permit(await acc.getAddress(), '0b10001001'))).rejects.toBeInstanceOf(PolicyViolationError)
  })

  it('confirm sees the account chain as `chain` and the domain chain as `domainChain`; signing works', async () => {
    const intents: WriteIntent[] = []
    const confirm = vi.fn(async (i: WriteIntent) => { intents.push(i); return true })
    const acc = await account({ blocklist: { [CHAIN]: ['0x0000000000000000000000000000000000000001'] }, confirm }, true)
    await expect(acc.signTypedData(permit(await acc.getAddress(), 137))).resolves.toMatch(/^0x/)
    expect(intents[0]).toMatchObject({ chain: CHAIN, domainChain: POLYGON, kind: 'approval' })
  })

  it('same-chain typed data: domainChain is the account chain, no extra refusal', async () => {
    const intents: WriteIntent[] = []
    const acc = await account({ blocklist: { [POLYGON]: [SPENDER] }, confirm: async (i) => { intents.push(i); return true } }, false)
    await expect(acc.signTypedData(permit(await acc.getAddress(), 1))).resolves.toMatch(/^0x/)
    expect(intents[0]).toMatchObject({ chain: CHAIN, domainChain: CHAIN })
  })
})

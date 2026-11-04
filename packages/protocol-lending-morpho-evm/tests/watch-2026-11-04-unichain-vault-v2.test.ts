// Watch 2026-11-04, unichain-vault-v2-factory: docs.morpho.org lists a VaultV2Factory on Unichain
// (0xC9b34c10…04a0c9; verified on-chain: same bytecode as the Base and Katana factories, and
// isVaultV2 acknowledges the Morpho API's Unichain V2 vaults). The preset had no V2 factory there,
// so every Unichain V2 vault was refused as unverified.
import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { FACTORY_V1_ABI, FACTORY_V2_ABI } from '../src/abi.js'
import { MORPHO_CHAINS, MorphoVaultProtocolEvm } from '../src/index.js'
import { E6, USDC, USER, VAULT_V2, makeMorpho } from './fixture.js'

const UNICHAIN_V2_FACTORY = '0xC9b34c108014B44e5a189A830e7e04c56704a0c9'

describe('Unichain Vault V2 factory', () => {
  it('is pinned in the preset', () => {
    expect(MORPHO_CHAINS[130]).toMatchObject({ name: 'Unichain', vaultV2Factories: [UNICHAIN_V2_FACTORY] })
  })

  it('a V2 vault it acknowledges is recognised on Unichain, and a deposit is planned', async () => {
    const { chain } = makeMorpho()
    chain.chainId = 130
    const c = MORPHO_CHAINS[130]!
    chain.on(c.vaultV1Factories[0]!, FACTORY_V1_ABI, (fn) => { if (fn === 'isMetaMorpho') return false; throw new Error(fn) })
    chain.on(UNICHAIN_V2_FACTORY, FACTORY_V2_ABI, (fn, args) => { if (fn === 'isVaultV2') return (args[0] as string).toLowerCase() === VAULT_V2.toLowerCase(); throw new Error(fn) })
    const acc = createMockAccount({ chain: 'eip155:130', address: USER })
    const p = new MorphoVaultProtocolEvm(acc, { vault: VAULT_V2, provider: chain.provider, api: null })
    expect(await p.getVault()).toMatchObject({ version: 'v2', factory: UNICHAIN_V2_FACTORY, asset: { address: USDC } })
    await p.supply({ amount: 10n * E6 })
    expect(acc.sent).toHaveLength(2)
  })
})

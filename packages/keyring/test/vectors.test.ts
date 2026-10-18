import { describe, expect, it } from 'vitest'
import { mnemonicToAccount } from 'viem/accounts'
import { ABANDON, CHAINS, fresh } from './helpers.js'
import { CHAIN_SPECS, type ChainKey } from '../src/index.js'

// "abandon ×11 about", accounts 0..4. Index 0 matches the public reference
// vectors: MetaMask 0x9858…, Phantom HAgk…, BIP-84 bc1qcr8te…, TronLink TUEZ….
const GOLDEN: Record<ChainKey, string[]> = {
  evm: ['0x9858EfFD232B4033E47d90003D41EC34EcaEda94', '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0', '0xb6716976A3ebe8D39aCEB04372f22Ff8e6802D7A', '0xF3f50213C1d2e255e4B2bAD430F8A38EEF8D718E', '0x51cA8ff9f1C0a99f88E86B8112eA3237F55374cA'],
  solana: ['HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', 'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb', '7WktogJEd2wQ9eH2oWusmcoFTgeYi6rS632UviTBJ2jm', '3YqEpfo3c818GhvbQ1UmVY1nJxw16vtu4JB9peJXT94k', '6nod592sTfEWD3VSVPdQndLMVBCNmMc6ngt7MyGBK21j'],
  ton: ['UQBHyu-oZVDHRYQ1-rKlGqpHy5yAqanPBirEQNMNOmfHLtaT', 'UQAockb65N9NqreZHrYfhipG94Q_gZYTBkV0mvaopLEEzOgi', 'UQD8esjfHjcGSc0Oj-QzD0hK1--zxSZAmwuDrqsVzPop9VSg', 'UQDx1-99xaRYXL77PDwxIQk-lg-J_KwLvG1CdJzS4i2acNaB', 'UQCTbg3YCqXGFkVMWg7Ji_8qmDD1O5ehenThPH7uC60Ky_vq'],
  tron: ['TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH', 'TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK', 'TYJPRrdB5APNeRs4R7fYZSwW3TcrTKw2gx', 'TRhVWK5XEDkQBDevcdCWW7RW51aRncty4W', 'TT2X2yyubp7qpAWYYNE5JQWBtoZ7ikQFsY'],
  btc: ['bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g', 'bc1qp59yckz4ae5c4efgw2s5wfyvrz0ala7rgvuz8z', 'bc1qgl5vlg0zdl7yvprgxj9fevsc6q6x5dmcyk3cn3', 'bc1qm97vqzgj934vnaq9s53ynkyf9dgr05rargr04n'],
  near: ['5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412', '3b93b03253b9715213ec314eb50ecc99d25602ccb5b059f91f51d24710d54326', '06ff7a6fae3da4d225a93da1fac0eb9adc64a33c417dd14a99a373b4bab4047a', '1554a4e6f52bbb7d4389f2f6282cbc4329a3503fa770fd5c9dd1aeb4bf2c2f1d', 'dff570730823421b60381bef2054cbfd28dfc83375edc2302c26d8161bbc192b'],
  zcash: ['t1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F', 't1aQ2b1XszNVo15BguYLbQGqETBL9QZA8Jq', 't1gLHX58QpcZr2SfaMhc5XbxabE455KZhoA', 't1M4FWL2VYmWy5qEuPUHrhEEcxsdkZ79xYn', 't1QAU8388aa3G9DXnbGSverQoEoz3WeGEiy'],
}

describe('multi-account golden vectors (i = 0..4)', () => {
  it('keyring accounts 0..4 derive the golden addresses on every chain', async () => {
    const { keyring } = await fresh()
    const { source } = await keyring.importMnemonic(ABANDON)
    for (let i = 1; i < 5; i++) await keyring.addAccount(source.id)
    for (const chain of Object.keys(GOLDEN) as ChainKey[]) {
      expect(keyring.listAccounts().map((a) => a.addresses[chain]), chain).toEqual(GOLDEN[chain])
    }
  })

  it('matches the chain managers built from the phrase (how apps derive today) — no address moves', async () => {
    for (const chain of Object.keys(GOLDEN) as ChainKey[]) {
      const m = new CHAINS[chain].Manager(ABANDON, {})
      const direct: string[] = []
      for (let i = 0; i < 5; i++) direct.push(await (await m.getAccount(i)).getAddress())
      m.dispose()
      expect(direct, chain).toEqual(GOLDEN[chain])
    }
  })

  it('EVM matches an independent implementation (viem mnemonicToAccount, addressIndex)', () => {
    for (let i = 0; i < 5; i++) expect(mnemonicToAccount(ABANDON, { addressIndex: i }).address).toBe(GOLDEN.evm[i])
  })

  it('documents the changing path segment per chain', () => {
    expect(CHAIN_SPECS.evm.accountPath(3)).toBe("m/44'/60'/0'/0/3")
    expect(CHAIN_SPECS.solana.accountPath(3)).toBe("m/44'/501'/3'/0'")
    expect(CHAIN_SPECS.ton.accountPath(3)).toBe("m/44'/607'/3'")
    expect(CHAIN_SPECS.tron.accountPath(3)).toBe("m/44'/195'/0'/0/3")
    expect(CHAIN_SPECS.btc.accountPath(3)).toBe("m/84'/0'/0'/0/3")
    expect(CHAIN_SPECS.near.accountPath(3)).toBe("m/44'/397'/3'")
  })
})

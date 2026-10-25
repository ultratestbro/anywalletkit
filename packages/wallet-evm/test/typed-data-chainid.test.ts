import { describe, expect, it } from 'vitest'
import { hashTypedData, recoverAddress, type Hex } from 'viem'
import { WalletManagerEvm, type WalletAccountReadOnlyEvm } from '../src/index.js'

// Audit 2026-10-25, #1.6: signTypedData normalised a string domain chainId ("0x89", "137") before
// hashing, verifyTypedData hashed the domain as given — our own signature did not verify.
const SEED = 'test test test test test test test test test test test junk'
const typed = (chainId: unknown) => ({
  domain: { name: 'Orders', version: '1', chainId, verifyingContract: '0x0000000000000000000000000000000000000001' },
  types: { Order: [{ name: 'maker', type: 'address' }, { name: 'amount', type: 'uint256' }] },
  primaryType: 'Order',
  message: { maker: '0x0000000000000000000000000000000000000002', amount: 5n },
})

describe('EIP-712 with a string chainId: sign and verify agree', () => {
  for (const chainId of ['0x89', '137', 137, 137n]) {
    it(`chainId ${typeof chainId} ${String(chainId)}`, async () => {
      const a = await new WalletManagerEvm(SEED, { chainId: 137, allowCrossChainTypedData: true }).getAccount(0)
      const sig = await a.signTypedData(typed(chainId) as never)
      expect(await a.verifyTypedData(typed(chainId) as never, sig)).toBe(true)
      // and the signature is over the domain WITH chainId 137, as a verifying contract computes it
      const hash = hashTypedData({ ...typed(137), domain: { ...typed(137).domain, chainId: 137 } } as never)
      expect((await recoverAddress({ hash, signature: sig as Hex })).toLowerCase()).toBe((await a.getAddress()).toLowerCase())
    })
  }

  it('the read-only account verifies the same way', async () => {
    const m = new WalletManagerEvm(SEED, { chainId: 137 })
    const a = await m.getAccount(0)
    const sig = await a.signTypedData(typed('0x89') as never)
    expect(await (a.toReadOnlyAccount() as WalletAccountReadOnlyEvm).verifyTypedData(typed('0x89') as never, sig)).toBe(true)
  })
})

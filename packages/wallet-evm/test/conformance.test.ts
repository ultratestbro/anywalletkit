import { describe, expect, it } from 'vitest'
import { describeChainModule, derivationVectors } from '@forgewallet/conformance'
import { WalletManagerEvm, type WalletAccountEvm } from '../src/index.js'

describeChainModule('wallet-evm', {
  chain: 'evm',
  create: (seed) => new WalletManagerEvm(seed),
  publicKeyOf: async (a) => (a as WalletAccountEvm).publicKey,
})

describe('wallet-evm: signature parity beyond the shared suite', () => {
  for (const [seedName, mnemonic] of Object.entries(derivationVectors.seeds)) {
    for (const vec of derivationVectors.vectors.evm[seedName]!.accounts) {
      it(`${seedName} #${vec.index}: EIP-1559 signTransaction matches the vector byte-for-byte (offline)`, async () => {
        const m = new WalletManagerEvm(mnemonic)
        const a = await m.getAccount(vec.index)
        const tx = derivationVectors.evmTx as { to: string; value: string; data: string; nonce: number; gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string; chainId: number; type: number }
        const raw = await a.signTransaction({ ...tx, value: BigInt(tx.value), gasLimit: BigInt(tx.gasLimit), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) })
        expect(raw).toBe(vec.signTransaction)
        m.dispose()
      })
      it(`${seedName} #${vec.index}: EIP-712 signTypedData matches the vector`, async () => {
        const m = new WalletManagerEvm(mnemonic)
        const a = await m.getAccount(vec.index)
        const sig = await a.signTypedData(derivationVectors.evmTypedData as never)
        expect(sig).toBe(vec.signTypedData)
        // and verifies against ourselves
        expect(await a.verifyTypedData(derivationVectors.evmTypedData as never, sig)).toBe(true)
        m.dispose()
      })
    }
  }
})

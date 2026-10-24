import { describe, expect, it } from 'vitest'
import { inspect } from 'node:util'
import { bytesToHex } from 'viem'
import { deriveSecp256k1, seedFromMnemonicSync } from '@anywalletkit/core'
import { describeChainModule, derivationVectors } from '@anywalletkit/conformance'
import { WalletManagerEvm, type WalletAccountEvm } from '../src/index.js'

describeChainModule('wallet-evm', {
  chain: 'evm',
  create: (seed) => new WalletManagerEvm(seed),
  fromSigner: (signer) => new WalletManagerEvm(signer),
  curve: 'secp256k1',
  publicKeyOf: async (a) => (a as WalletAccountEvm).publicKey,
})

describe('wallet-evm: signatures match the pinned vectors beyond the shared suite', () => {
  for (const [seedName, mnemonic] of Object.entries(derivationVectors.seeds)) {
    for (const vec of derivationVectors.vectors.evm[seedName]!.accounts) {
      it(`${seedName} #${vec.index}: EIP-1559 signTransaction matches the vectors byte-for-byte (offline)`, async () => {
        const m = new WalletManagerEvm(mnemonic)
        const a = await m.getAccount(vec.index)
        const tx = derivationVectors.evmTx as { to: string; value: string; data: string; nonce: number; gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string; chainId: number; type: number }
        const raw = await a.signTransaction({ ...tx, value: BigInt(tx.value), gasLimit: BigInt(tx.gasLimit), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) })
        expect(raw).toBe(vec.signTransaction)
        m.dispose()
      })
      it(`${seedName} #${vec.index}: EIP-712 signTypedData matches the vectors`, async () => {
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

describe('wallet-evm: an account carries no secret in its rendering (2026-10-23 audit)', () => {
  it('neither the private key nor the master seed shows in inspect / JSON, from a phrase or from seed bytes', async () => {
    const phrase = derivationVectors.seeds['hardhat-12']!
    const seed = seedFromMnemonicSync(phrase)
    const key = deriveSecp256k1(seed, "m/44'/60'/0'/0/0").privateKey
    for (const manager of [new WalletManagerEvm(phrase), new WalletManagerEvm(seed)]) {
      const account = await manager.getAccount(0)
      expect(await account.getAddress()).toBe(derivationVectors.vectors.evm['hardhat-12']!.accounts[0]!.address)
      const seen = new WeakSet<object>()
      const json = JSON.stringify(account, (_k, v: unknown) => {
        if (typeof v === 'bigint') return v.toString()
        if (typeof v === 'object' && v !== null) { if (seen.has(v)) return undefined; seen.add(v) }
        return v
      })
      for (const text of [inspect(account, { depth: 10, showHidden: true }), json, inspect(manager, { depth: 10, showHidden: true })]) {
        for (const secret of [key, seed]) {
          expect(text.toLowerCase()).not.toContain(bytesToHex(secret).slice(2))
          expect(text).not.toContain(Array.from(secret.slice(0, 8)).join(', '))
          expect(text).not.toContain(Array.from(secret.slice(0, 8)).map((b, i) => `"${i}":${b}`).join(','))
        }
      }
      manager.dispose()
    }
  })
})

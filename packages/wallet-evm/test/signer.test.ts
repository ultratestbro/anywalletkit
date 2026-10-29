import { describe, expect, it } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hexToBytes, recoverMessageAddress, recoverTransactionAddress, recoverTypedDataAddress, type Hex, type TransactionSerialized } from 'viem'
import { LocalSigner, SignerError, UserRejectedError, externalSigner, seedFromMnemonicSync } from '@anywalletkit/core'
import { EVM_BASE_PATH, WalletAccountEvm, WalletManagerEvm } from '../src/index.js'

const SEED = 'test test test test test test test test test test test junk'
const HARDHAT0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const HARDHAT0_KEY = hexToBytes('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const TX = { to: '0x000000000000000000000000000000000000bEEF', value: 1n, chainId: 1, nonce: 0, gasLimit: 21_000, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }
const TYPED = {
  domain: { name: 'T', version: '1', chainId: 1, verifyingContract: '0x000000000000000000000000000000000000bEEF' },
  types: { Thing: [{ name: 'x', type: 'uint256' }] },
  message: { x: 7n },
}

/** A "hardware wallet": holds the Hardhat key outside the SDK, signs recoverable ECDSA on request. */
function hardwareWallet(reject = false) {
  const contexts: string[] = []
  const signer = externalSigner({
    curve: 'secp256k1',
    publicKey: secp256k1.getPublicKey(HARDHAT0_KEY),
    sign: async (payload, o) => {
      contexts.push(o.context ?? '')
      if (reject) throw new UserRejectedError()
      const r = secp256k1.sign(payload, HARDHAT0_KEY, { prehash: false, format: 'recovered' })
      const out = new Uint8Array(65); out.set(r.subarray(1)); out[64] = r[0]!
      return out
    },
  })
  return { signer, contexts }
}

describe('WalletManagerEvm with an external signer', () => {
  it('builds the account at the signer key and signs tx / 191 / 712 through it', async () => {
    const { signer, contexts } = hardwareWallet()
    const m = new WalletManagerEvm(signer, { chainId: 1 })
    const a = await m.getAccount(0)
    expect(await a.getAddress()).toBe(HARDHAT0)
    expect(a.path).toBe('external')
    expect(a.signerKind).toBe('external')
    expect(Reflect.get(a, 'signer')).toBeUndefined() // the signer is a private field (audit 2026-10-29 A1)
    expect(await m.getAccount()).toBe(a)

    const raw = (await a.signTransaction(TX)) as TransactionSerialized
    expect(await recoverTransactionAddress({ serializedTransaction: raw })).toBe(HARDHAT0)
    const sig191 = (await a.sign('hello')) as Hex
    expect(await recoverMessageAddress({ message: 'hello', signature: sig191 })).toBe(HARDHAT0)
    const sig712 = (await a.signTypedData(TYPED)) as Hex
    expect(await recoverTypedDataAddress({ ...TYPED, primaryType: 'Thing', signature: sig712 } as never)).toBe(HARDHAT0)
    expect(contexts).toEqual(['evm-tx', 'evm-191', 'evm-712'])
  })

  it('refuses other indexes/paths, the wrong curve, and surfaces UserRejectedError', async () => {
    const m = new WalletManagerEvm(hardwareWallet().signer)
    await expect(m.getAccount(1)).rejects.toThrow(/one account/)
    await expect(m.getAccountByPath("m/44'/60'/0'/0/3")).rejects.toThrow(SignerError)
    const ed = LocalSigner.fromSeed(seedFromMnemonicSync(SEED), 'ed25519', "m/44'/501'/0'/0'")
    await expect(new WalletManagerEvm(ed).getAccount()).rejects.toThrow(/secp256k1/)
    const a = await new WalletManagerEvm(hardwareWallet(true).signer, { chainId: 1 }).getAccount()
    await expect(a.signTransaction(TX)).rejects.toBeInstanceOf(UserRejectedError)
  })

  it('a derivable SeedSigner at the account root yields the same children as the seed manager', async () => {
    const bySeed = new WalletManagerEvm(SEED)
    const root = LocalSigner.fromSeed(seedFromMnemonicSync(SEED), 'secp256k1', EVM_BASE_PATH)
    const bySigner = new WalletManagerEvm(root)
    for (const i of [0, 1, 5]) {
      expect(await (await bySigner.getAccount(i)).getAddress()).toBe(await (await bySeed.getAccount(i)).getAddress())
    }
    expect((await bySigner.getAccount(1)).path).toBe(`${EVM_BASE_PATH}/1`)
    await expect(bySigner.getAccountByPath("m/44'/61'/0'/0/0")).rejects.toThrow(/cannot provide/)
    // a leaf SeedSigner is index 0 only
    const leaf = LocalSigner.fromSeed(seedFromMnemonicSync(SEED), 'secp256k1', `${EVM_BASE_PATH}/0`)
    const lm = new WalletManagerEvm(leaf)
    expect(await (await lm.getAccount(0)).getAddress()).toBe(HARDHAT0)
    await expect(lm.getAccount(2)).rejects.toThrow(/cannot provide/)
    bySeed.dispose(); bySigner.dispose(); lm.dispose()
  })

  it('fromPrivateKey keeps the raw-key constructor shape; dispose disposes the signer', async () => {
    const a = WalletAccountEvm.fromPrivateKey(HARDHAT0_KEY.slice(), secp256k1.getPublicKey(HARDHAT0_KEY), 'x', { chainId: 1 })
    expect(a.address).toBe(HARDHAT0)
    expect(await recoverTransactionAddress({ serializedTransaction: (await a.signTransaction(TX)) as TransactionSerialized })).toBe(HARDHAT0)
    a.dispose()
    await expect(a.sign('x')).rejects.toBeInstanceOf(SignerError)
  })

  it('manager.dispose() disposes an injected signer', async () => {
    const { signer } = hardwareWallet()
    const m = new WalletManagerEvm(signer, { chainId: 1 })
    const a = await m.getAccount()
    m.dispose()
    await expect(a.sign('x')).rejects.toBeInstanceOf(SignerError)
  })
})

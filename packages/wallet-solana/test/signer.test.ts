import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { getBase64Encoder, getTransactionDecoder, type Address } from '@solana/kit'
import { LocalSigner, SignerError, UserRejectedError, deriveEd25519, externalSigner, seedFromMnemonicSync } from '@anywalletkit/core'
import { SOLANA_BASE_PATH, WalletAccountSolana, WalletManagerSolana, type SolanaRpc } from '../src/index.js'

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR0 = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' // account 0
const RECIPIENT = 'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb' as Address // account 1
const BLOCKHASH = '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6'

/** The account-0 key, held OUTSIDE the SDK as a "hardware wallet" would. */
function account0Key(): Uint8Array {
  // LocalSigner never exposes its key; derive the raw bytes for the fake device.
  return deriveEd25519(seedFromMnemonicSync(SEED), `${SOLANA_BASE_PATH}/0'/0'`).privateKey
}

function hardwareWallet(reject = false) {
  const key = account0Key()
  const contexts: string[] = []
  const signer = externalSigner({
    curve: 'ed25519',
    publicKey: ed25519.getPublicKey(key),
    sign: async (payload, o) => {
      contexts.push(o.context ?? '')
      if (reject) throw new UserRejectedError()
      return ed25519.sign(payload, key)
    },
  })
  return { signer, contexts, publicKey: ed25519.getPublicKey(key) }
}

/** Minimal fake RPC for a SOL transfer: blockhash, fee, balance, simulation, send. */
function fakeRpc() {
  const sent: string[] = []
  const handlers: Record<string, (...a: unknown[]) => unknown> = {
    getLatestBlockhash: () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }),
    getFeeForMessage: () => ({ value: 5000n }),
    getBalance: () => ({ value: 1_000_000_000n }),
    getAccountInfo: () => ({ value: null }),
    getMultipleAccounts: (list: unknown) => ({ value: (list as unknown[]).map(() => null) }), // the CPI guard's pre-state read (round 3)
    simulateTransaction: (_w: unknown, cfg: unknown) => ({ value: { err: null, unitsConsumed: 20_000n, logs: [], ...((cfg as { accounts?: { addresses: unknown[] } } | undefined)?.accounts ? { accounts: (cfg as { accounts: { addresses: unknown[] } }).accounts.addresses.map(() => null) } : {}) } }), // post-state for the CPI guard (round 3)
    sendTransaction: (wire) => { sent.push(wire as string); return 'A'.repeat(87) },
    getRecentPrioritizationFees: () => [{ prioritizationFee: 1000, slot: 1n }],
  }
  const rpc = new Proxy({} as SolanaRpc, { get: (_t, m: string) => (...args: unknown[]) => ({ send: async () => { const h = handlers[m]; if (!h) throw new Error(`unmocked ${m}`); return h(...args) } }) })
  return { rpc, sent }
}

const decodeWire = (wire: string) => getTransactionDecoder().decode(getBase64Encoder().encode(wire))

describe('WalletManagerSolana with an external signer', () => {
  it('builds the account at the signer key and signs a SOL transfer + off-chain message through it', async () => {
    const { signer, contexts, publicKey } = hardwareWallet()
    const { rpc, sent } = fakeRpc()
    const m = new WalletManagerSolana(signer, { provider: rpc })
    const a = await m.getAccount(0)
    expect(a.address).toBe(ADDR0)
    expect(a.path).toBe('external')
    expect(a.signer).toBe(signer)
    expect(await m.getAccount()).toBe(a)

    await a.transfer({ recipient: RECIPIENT, amount: 1_000n })
    const tx = decodeWire(sent[0]!)
    const sig = tx.signatures[ADDR0 as Address] as Uint8Array
    expect(ed25519.verify(sig, tx.messageBytes as unknown as Uint8Array, publicKey)).toBe(true)
    // fee payer is the first static account = the signer's address
    expect(Object.keys(tx.signatures)[0]).toBe(ADDR0)

    const off = await a.sign('hello')
    expect(ed25519.verify(Uint8Array.from(Buffer.from(off, 'hex')), new TextEncoder().encode('hello'), publicKey)).toBe(true)
    expect(contexts).toEqual(['solana-message', 'solana-offchain'])
  })

  it('refuses other indexes/paths, the wrong curve, and surfaces UserRejectedError', async () => {
    const m = new WalletManagerSolana(hardwareWallet().signer)
    await expect(m.getAccount(1)).rejects.toThrow(/one account/)
    await expect(m.getAccountByPath("m/44'/501'/3'/0'")).rejects.toThrow(SignerError)
    const secp = LocalSigner.fromSeed(seedFromMnemonicSync(SEED), 'secp256k1', "m/44'/60'/0'/0/0")
    await expect(new WalletManagerSolana(secp).getAccount()).rejects.toThrow(/ed25519/)
    const { rpc } = fakeRpc()
    const a = await new WalletManagerSolana(hardwareWallet(true).signer, { provider: rpc }).getAccount()
    await expect(a.transfer({ recipient: RECIPIENT, amount: 1n })).rejects.toBeInstanceOf(UserRejectedError)
  })

  it('a derivable SeedSigner at m/44\'/501\' yields the same children as the seed manager', async () => {
    const bySeed = new WalletManagerSolana(SEED)
    const root = LocalSigner.fromSeed(seedFromMnemonicSync(SEED), 'ed25519', SOLANA_BASE_PATH)
    const bySigner = new WalletManagerSolana(root)
    for (const i of [0, 1, 5]) {
      expect(await (await bySigner.getAccount(i)).getAddress()).toBe(await (await bySeed.getAccount(i)).getAddress())
    }
    expect((await bySigner.getAccount(1)).path).toBe(`${SOLANA_BASE_PATH}/1'/0'`)
    await expect(bySigner.getAccountByPath("m/44'/60'/0'/0/0")).rejects.toThrow(/hardened|cannot provide/)
    // a leaf SeedSigner is index 0 only
    const leaf = LocalSigner.fromSeed(seedFromMnemonicSync(SEED), 'ed25519', `${SOLANA_BASE_PATH}/0'/0'`)
    const lm = new WalletManagerSolana(leaf)
    expect((await lm.getAccount(0)).address).toBe(ADDR0)
    await expect(lm.getAccount(2)).rejects.toThrow(/cannot provide/)
    bySeed.dispose(); bySigner.dispose(); lm.dispose()
  })

  it('fromPrivateKey keeps the raw-key shape; dispose disposes the signer', async () => {
    const key = account0Key()
    const a = WalletAccountSolana.fromPrivateKey(key, ed25519.getPublicKey(key), 'x')
    expect(a.address).toBe(ADDR0)
    expect(a.signer.kind).toBe('seed')
    const sig = await a.sign('x')
    expect(sig).toHaveLength(128)
    a.dispose()
    await expect(a.sign('x')).rejects.toBeInstanceOf(SignerError)
  })

  it('manager.dispose() disposes an injected signer', async () => {
    const { signer } = hardwareWallet()
    const m = new WalletManagerSolana(signer)
    const a = await m.getAccount()
    m.dispose()
    await expect(a.sign('x')).rejects.toBeInstanceOf(SignerError)
  })
})

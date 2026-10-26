import { describe, expect, it } from 'vitest'
import {
  appendTransactionMessageInstructions, compileTransaction, createNoopSigner, createTransactionMessage, getBase64EncodedWireTransaction, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, setTransactionMessageLifetimeUsingDurableNonce,
  type Address, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import { UnsafeTransactionError, WalletManagerSolana, describeTransaction, type SolanaConfig, type SolanaRpc } from '../src/index.js'

// Audit 2026-10-25 round 3, M9: a transaction whose first instruction is AdvanceNonceAccount (a
// durable nonce) never expires — a dApp can hold the signature and broadcast it months later. It
// was signed silently. The description now says `lifetime: 'durable-nonce'` with a warning, and
// signing refuses it unless `allowDurableNonce` is set in the config or the call's options.

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ME = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' as Address
const TO = 'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb' as Address
const NONCE_ACCOUNT = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as Address
const NONCE = '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6'

function fakeRpc() {
  const handlers: Record<string, (...a: unknown[]) => unknown> = {
    getLatestBlockhash: () => ({ value: { blockhash: NONCE, lastValidBlockHeight: 100n } }),
    getFeeForMessage: () => ({ value: 5000n }),
    getRecentPrioritizationFees: () => [],
    getMultipleAccounts: (addresses) => ({ value: (addresses as unknown[]).map(() => null) }),
    simulateTransaction: (_w, cfg) => ({ value: { err: null, unitsConsumed: 20_000n, logs: [], ...((cfg as { accounts?: { addresses: unknown[] } })?.accounts ? { accounts: (cfg as { accounts: { addresses: unknown[] } }).accounts.addresses.map(() => null) } : {}) } }),
    sendTransaction: () => 'A'.repeat(87),
  }
  return new Proxy({} as SolanaRpc, { get: (_t, m: string) => (...args: unknown[]) => ({ send: async () => { const h = handlers[m]; if (!h) throw new Error(`unmocked ${m}`); return h(...args) } }) })
}
async function account(config: Partial<SolanaConfig> = {}) {
  return new WalletManagerSolana(SEED, { provider: fakeRpc(), ...config }).getAccount(0)
}
const transfer = getTransferSolInstruction({ source: createNoopSigner(ME), destination: TO, amount: 1n })
const base = () => pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayer(ME, m))
const durable = () => pipe(base(), (m) => setTransactionMessageLifetimeUsingDurableNonce({ nonce: NONCE as never, nonceAccountAddress: NONCE_ACCOUNT, nonceAuthorityAddress: ME }, m), (m) => appendTransactionMessageInstructions([transfer], m)) as unknown as TransactionMessage
const recent = () => pipe(base(), (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: NONCE as never, lastValidBlockHeight: 100n }, m), (m) => appendTransactionMessageInstructions([transfer], m)) as unknown as TransactionMessage

describe('durable-nonce transactions', () => {
  it('describe names the lifetime and warns', () => {
    const d = describeTransaction(durable(), { account: ME })
    expect(d.lifetime).toBe('durable-nonce')
    expect(d.items[0]).toMatchObject({ instruction: 'AdvanceNonceAccount' })
    expect(d.warnings.map((w) => w.code)).toContain('durable-nonce')
    const r = describeTransaction(recent(), { account: ME })
    expect(r.lifetime).toBe('blockhash')
    expect(r.warnings.map((w) => w.code)).not.toContain('durable-nonce')
    const wire = getBase64EncodedWireTransaction(compileTransaction(durable() as never) as Transaction)
    expect(describeTransaction(wire, { account: ME }).lifetime).toBe('durable-nonce')
  })

  it('signing refuses it by default: message, compiled and wire', async () => {
    const a = await account()
    await expect(a.signTransaction(durable())).rejects.toMatchObject({ name: 'UnsafeTransactionError', code: 'durable-nonce' })
    await expect(a.sendTransaction(durable())).rejects.toBeInstanceOf(UnsafeTransactionError)
    const wire = getBase64EncodedWireTransaction(compileTransaction(durable() as never) as Transaction)
    await expect(a.signTransaction(wire)).rejects.toMatchObject({ code: 'durable-nonce' })
    await expect(a.quoteSendTransaction(durable())).rejects.toMatchObject({ code: 'durable-nonce' })
    await expect(a.signTransaction(recent())).resolves.toBeTypeOf('string')
  })

  it('allowDurableNonce in the config or the call lets it through', async () => {
    await expect((await account({ allowDurableNonce: true })).signTransaction(durable())).resolves.toBeTypeOf('string')
    await expect((await account()).signTransaction(durable(), { allowDurableNonce: true })).resolves.toBeTypeOf('string')
  })
})

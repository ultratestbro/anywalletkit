import { ed25519 } from '@noble/curves/ed25519.js'
import { describe, expect, it } from 'vitest'
import { WalletAccountReadOnlyNear, WalletManagerNear, decodeSignedTransaction, fromBase64, type NearAction, type NearBuiltTransaction } from '../src/index.js'
import { ACCOUNT0, BLOCK, SEED, fakeNode } from './fake-node.js'

// The checks and the signature read one plain copy of the transaction, so an object that changes
// between reads (a getter, or an array the caller edits while a node call is awaited) cannot get a
// different transaction signed from the one that was checked.

const OTHER_KEY = { keyType: 'ed25519' as const, data: new Uint8Array(32).fill(0xaa) }
const ADD_KEY: NearAction = { addKey: { publicKey: OTHER_KEY, accessKey: { nonce: 0n, permission: { fullAccess: {} } } } }
const TRANSFER: NearAction = { transfer: { deposit: 1n } }

describe('NEAR signing reads its own copy of the transaction', () => {
  for (const flipAt of [1, 2, 3, 5, 10, 20]) {
    for (const [first, then] of [[TRANSFER, ADD_KEY], [ADD_KEY, TRANSFER]] as const) {
      it(`signBuilt: an actions getter that switches ${Object.keys(first)[0]} -> ${Object.keys(then)[0]} at read ${flipAt} never gets AddKey signed`, async () => {
        const a = await new WalletManagerNear(SEED, { provider: fakeNode().fetch }).getAccount(0)
        let reads = 0
        const tx = { signerId: ACCOUNT0, publicKey: a.publicKey, nonce: 42n, receiverId: ACCOUNT0, blockHash: new Uint8Array(32).fill(9) } as NearBuiltTransaction
        Object.defineProperty(tx, 'actions', { enumerable: true, get: () => (++reads >= flipAt ? [then] : [first]) })
        const r = await a.signBuilt(tx).catch((e: unknown) => e)
        if (r instanceof Error) {
          expect(r).toMatchObject({ code: 'dangerous-action' })
          return
        }
        // Signed: what the signature covers is exactly the returned (checked) transaction, which holds no AddKey.
        expect(r.transaction.actions).toEqual([TRANSFER])
        const evil = { ...r.transaction, actions: [ADD_KEY] }
        expect(ed25519.verify(r.signature.data, WalletAccountReadOnlyNear.hashOf(evil), a.publicKey.data)).toBe(false)
        expect(ed25519.verify(r.signature.data, WalletAccountReadOnlyNear.hashOf(r.transaction), a.publicKey.data)).toBe(true)
      })
    }
  }

  it('sendTransaction: an AddKey pushed into the caller\'s actions during the node calls is not signed', async () => {
    const node = fakeNode()
    const actions: NearAction[] = [TRANSFER]
    let mutated = false
    const provider: typeof node.fetch = async (method, params) => {
      const p = params as Record<string, unknown>
      if (!mutated && method === 'query' && p.request_type === 'view_access_key') {
        mutated = true
        actions.push(ADD_KEY)
      }
      return node.fetch(method, params)
    }
    const a = await new WalletManagerNear(SEED, { provider }).getAccount(0)
    await a.sendTransaction({ receiverId: 'alice.near', actions, nonce: 100n, blockHash: BLOCK })
    expect(mutated).toBe(true)
    expect(node.sent.length).toBe(1)
    const sent = decodeSignedTransaction(fromBase64(node.sent[0]!))
    expect(sent.transaction.actions.map((x) => Object.keys(x)[0])).toEqual(['transfer'])
  })

  it('control: a function call with JSON args signs to the same bytes as before', async () => {
    const a = await new WalletManagerNear(SEED, { provider: fakeNode().fetch }).getAccount(0)
    const tx: NearBuiltTransaction = {
      signerId: ACCOUNT0, publicKey: a.publicKey, nonce: 42n, receiverId: 'usdt.tether-token.near', blockHash: new Uint8Array(32).fill(9),
      actions: [{ functionCall: { methodName: 'ft_transfer', args: { receiver_id: 'bob.near', amount: '1' }, gas: 30n * 10n ** 12n, deposit: 1n } }],
    }
    const signed = await a.signBuilt(tx)
    expect(ed25519.verify(signed.signature.data, WalletAccountReadOnlyNear.hashOf(tx), a.publicKey.data)).toBe(true)
  })

  it('a transaction that cannot be encoded keeps its classified refusal', async () => {
    const a = await new WalletManagerNear(SEED, { provider: fakeNode().fetch }).getAccount(0)
    const tx: NearBuiltTransaction = { signerId: ACCOUNT0, publicKey: a.publicKey, nonce: 42n, receiverId: ACCOUNT0, blockHash: new Uint8Array(31), actions: [TRANSFER] }
    await expect(a.signBuilt(tx)).rejects.toMatchObject({ code: 'missing-block-hash' })
  })
})

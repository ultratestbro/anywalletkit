import { describe, expect, it } from 'vitest'
import { WalletManagerNear, type NearBuiltTransaction } from '../src/index.js'
import { ACCOUNT0, SEED, fakeNode } from './fake-node.js'

// signBuilt runs the same hard checks as signTransaction: a dangerous action (a new full-access key,
// a deleted key or account, a contract deploy) is refused unless allowDangerousActions is set.

const OTHER_KEY = { keyType: 'ed25519' as const, data: new Uint8Array(32).fill(0xaa) }

async function setup(config: { allowDangerousActions?: boolean } = {}) {
  const node = fakeNode()
  const calls: string[] = []
  const provider: typeof node.fetch = (method, params) => { calls.push(method); return node.fetch(method, params) }
  const a = await new WalletManagerNear(SEED, { provider, ...config }).getAccount(0)
  const tx = (actions: NearBuiltTransaction['actions'], over: Partial<NearBuiltTransaction> = {}): NearBuiltTransaction => ({
    signerId: ACCOUNT0, publicKey: a.publicKey, nonce: 42n, receiverId: ACCOUNT0, blockHash: new Uint8Array(32).fill(9), actions, ...over,
  })
  return { a, tx, calls }
}

const DANGEROUS: Array<[string, (own: NearBuiltTransaction['publicKey']) => NearBuiltTransaction['actions']]> = [
  ['AddKey(FullAccess)', () => [{ addKey: { publicKey: OTHER_KEY, accessKey: { nonce: 0n, permission: { fullAccess: {} } } } }]],
  ['DeleteKey(own key)', (own) => [{ deleteKey: { publicKey: own } }]],
  ['DeleteAccount', () => [{ deleteAccount: { beneficiaryId: 'someone.near' } }]],
  ['DeployContract', () => [{ deployContract: { code: new Uint8Array([0, 97, 115, 109]) } }]],
]

describe('NEAR signBuilt: dangerous actions', () => {
  for (const [name, actions] of DANGEROUS) {
    it(`${name}: refused by signBuilt, as by signTransaction`, async () => {
      const { a, tx } = await setup()
      await expect(a.signBuilt(tx(actions(a.publicKey)))).rejects.toMatchObject({ name: 'UnsafeTransactionError', code: 'dangerous-action' })
      await expect(a.signTransaction({ receiverId: ACCOUNT0, actions: actions(a.publicKey) })).rejects.toMatchObject({ code: 'dangerous-action' })
    })

    it(`${name}: signed with allowDangerousActions`, async () => {
      const { a, tx } = await setup({ allowDangerousActions: true })
      await expect(a.signBuilt(tx(actions(a.publicKey)))).resolves.toMatchObject({ signature: { keyType: 'ed25519' } })
    })
  }

  it('a plain transfer is still signed, without any node call', async () => {
    const { a, tx, calls } = await setup()
    calls.length = 0
    await expect(a.signBuilt(tx([{ transfer: { deposit: 1n } }], { receiverId: 'bob.near' }))).resolves.toMatchObject({ signature: { keyType: 'ed25519' } })
    expect(calls).toEqual([])
  })

  it('a transaction for another signer or key is refused', async () => {
    const { a, tx } = await setup()
    const actions = [{ transfer: { deposit: 1n } }]
    await expect(a.signBuilt(tx(actions, { signerId: 'bob.near' }))).rejects.toMatchObject({ code: 'signer-mismatch' })
    await expect(a.signBuilt(tx(actions, { publicKey: OTHER_KEY }))).rejects.toMatchObject({ code: 'public-key-mismatch' })
  })

  it('a dangerous action inside a batch is refused', async () => {
    const { a, tx } = await setup()
    const batch = [{ transfer: { deposit: 1n } }, ...DANGEROUS[0]![1](a.publicKey)]
    await expect(a.signBuilt(tx(batch))).rejects.toMatchObject({ code: 'dangerous-action' })
  })
})

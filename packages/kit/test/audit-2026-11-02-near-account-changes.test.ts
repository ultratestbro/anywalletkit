import { describe, expect, it, vi } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { encodeTransaction, toBase64, type NearBuiltTransaction } from '@anywalletkit/wallet-near'
import { applyPolicies, type WriteIntent } from '../src/index.js'

// A NEAR transaction to the own account that adds or deletes a key, deploys code or stakes moves
// nothing to anyone, but it can hand the account over: the intent says so instead of looking like a
// transfer to self.
const ME = 'alice.near'
const KEY = { keyType: 'ed25519' as const, data: new Uint8Array(32).fill(0xaa) }
const built = (actions: NearBuiltTransaction['actions']): NearBuiltTransaction => ({
  signerId: ME, publicKey: { keyType: 'ed25519', data: new Uint8Array(32).fill(1) }, nonce: 42n, receiverId: ME, blockHash: new Uint8Array(32).fill(9), actions,
})
const near = () => Object.assign(createMockAccount({ chain: 'near:mainnet', address: ME }), { signBuilt: async (tx: unknown) => tx })
type Built = { signBuilt(tx: unknown): Promise<unknown> }

const CASES: Array<[string, NearBuiltTransaction['actions'], string[]]> = [
  ['AddKey(FullAccess)', [{ addKey: { publicKey: KEY, accessKey: { nonce: 0n, permission: { fullAccess: {} } } } }], ['add-key', 'full-access-key']],
  ['AddKey(FunctionCall)', [{ addKey: { publicKey: KEY, accessKey: { nonce: 0n, permission: { functionCall: { receiverId: 'app.near', methodNames: [] } } } } }], ['add-key']],
  ['DeleteKey', [{ deleteKey: { publicKey: KEY } }], ['delete-key']],
  ['DeployContract', [{ deployContract: { code: new Uint8Array([0, 97, 115, 109]) } }], ['deploy-contract']],
  ['Stake', [{ stake: { stake: 1n, publicKey: KEY } }], ['stake']],
]

describe('NEAR: account changes are part of the write intent', () => {
  for (const [name, actions, changes] of CASES) {
    it(`${name}: signBuilt, sendTransaction and the borsh form carry accountChanges; an allowlist naming the own account refuses it`, async () => {
      const confirm = vi.fn(async (_i: WriteIntent) => true)
      await (applyPolicies(near(), { confirm }, 'near:mainnet') as unknown as Built).signBuilt(built(actions))
      await applyPolicies(near(), { confirm }, 'near:mainnet').sendTransaction({ receiverId: ME, actions } as never)
      await applyPolicies(near(), { confirm }, 'near:mainnet').sendTransaction(toBase64(encodeTransaction(built(actions))) as never)
      for (const [intent] of confirm.mock.calls) {
        expect(intent).toMatchObject({ kind: 'send', destinations: [ME], destinationUnknown: true })
        expect([...(intent.accountChanges ?? [])].sort()).toEqual([...changes].sort())
      }
      const allow = applyPolicies(near(), { allowlist: { near: [ME] } }, 'near:mainnet')
      await expect((allow as unknown as Built).signBuilt(built(actions))).rejects.toMatchObject({ policy: 'allowlist' })
      await expect(allow.sendTransaction({ receiverId: ME, actions } as never)).rejects.toMatchObject({ policy: 'allowlist' })
    })
  }

  it('DeleteAccount is listed, and judged by its beneficiary as before', async () => {
    const confirm = vi.fn(async (_i: WriteIntent) => true)
    const actions = [{ deleteAccount: { beneficiaryId: 'heir.near' } }]
    await applyPolicies(near(), { allowlist: { near: [ME, 'heir.near'] }, confirm }, 'near:mainnet').sendTransaction({ receiverId: ME, actions } as never)
    expect(confirm.mock.calls[0]![0]).toMatchObject({ accountChanges: ['delete-account'], destinations: [ME, 'heir.near'], destinationUnknown: false })
    await expect(applyPolicies(near(), { allowlist: { near: [ME] } }, 'near:mainnet').sendTransaction({ receiverId: ME, actions } as never)).rejects.toMatchObject({ policy: 'allowlist' })
  })

  it('control: a plain transfer or a token call has no accountChanges and passes the allowlist', async () => {
    const confirm = vi.fn(async (_i: WriteIntent) => true)
    const g = applyPolicies(near(), { allowlist: { near: ['bob.near'] }, confirm }, 'near:mainnet')
    await (g as unknown as Built).signBuilt({ ...built([{ transfer: { deposit: 1n } }]), receiverId: 'bob.near' })
    await g.sendTransaction({ receiverId: 'bob.near', actions: [{ transfer: { deposit: 1n } }] } as never)
    for (const [intent] of confirm.mock.calls) {
      expect(intent.accountChanges).toBeUndefined()
      expect(intent.destinationUnknown).toBe(false)
    }
  })
})

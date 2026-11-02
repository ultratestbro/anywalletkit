import { describe, expect, it, vi } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { encodeTransaction, toBase64, type NearBuiltTransaction } from '@anywalletkit/wallet-near'
import { applyPolicies, type WriteIntent } from '../src/index.js'

// The actions inside a SignedDelegate are account changes too, read the same way in object form and
// in borsh; and the borsh reader reads past a delegate or a global-contract action instead of stopping.
const ME = 'alice.near'
const KEY = { keyType: 'ed25519' as const, data: new Uint8Array(32).fill(0xaa) }
const SIG = { keyType: 'ed25519' as const, data: new Uint8Array(64).fill(3) }
const built = (actions: NearBuiltTransaction['actions'], receiverId = ME): NearBuiltTransaction => ({
  signerId: ME, publicKey: { keyType: 'ed25519', data: new Uint8Array(32).fill(1) }, nonce: 42n, receiverId, blockHash: new Uint8Array(32).fill(9), actions,
})
const near = () => Object.assign(createMockAccount({ chain: 'near:mainnet', address: ME }), { signBuilt: async (tx: unknown) => tx })
type Built = { signBuilt(tx: unknown): Promise<unknown> }
type Actions = NearBuiltTransaction['actions']
const addFull = { addKey: { publicKey: KEY, accessKey: { nonce: 0n, permission: { fullAccess: {} } } } }
const delegateOf = (senderId: string, receiverId: string, actions: unknown[]) => ({
  signedDelegate: { delegateAction: { senderId, receiverId, actions, nonce: 1n, maxBlockHeight: 100n, publicKey: KEY }, signature: SIG },
})
const ftTransfer = (to: string) => ({ functionCall: { methodName: 'ft_transfer', args: new TextEncoder().encode(JSON.stringify({ receiver_id: to, amount: '1' })), gas: 30_000_000_000_000n, deposit: 1n } })

/** The intent of each form: signBuilt (object), sendTransaction (object), sendTransaction (base64 borsh). */
async function intents(actions: Actions, receiverId = ME): Promise<WriteIntent[]> {
  const confirm = vi.fn(async (_i: WriteIntent) => true)
  await (applyPolicies(near(), { confirm }, 'near:mainnet') as unknown as Built).signBuilt(built(actions, receiverId))
  await applyPolicies(near(), { confirm }, 'near:mainnet').sendTransaction({ receiverId, actions } as never)
  await applyPolicies(near(), { confirm }, 'near:mainnet').sendTransaction(toBase64(encodeTransaction(built(actions, receiverId))) as never)
  return confirm.mock.calls.map(([i]) => i)
}
const view = (i: WriteIntent) => ({ d: [...i.destinations].sort(), u: i.destinationUnknown, c: i.accountChanges })

describe('NEAR: account changes inside a delegated action', () => {
  it('AddKey(FullAccess) inside a SignedDelegate: every form reports it and the own-account allowlist refuses', async () => {
    const actions = [delegateOf(ME, ME, [addFull])] as never as Actions
    const all = await intents(actions)
    for (const i of all) expect(view(i)).toEqual({ d: [ME], u: true, c: ['delegate', 'add-key', 'full-access-key'] })
    const allow = applyPolicies(near(), { allowlist: { near: [ME] } }, 'near:mainnet')
    await expect((allow as unknown as Built).signBuilt(built(actions))).rejects.toMatchObject({ policy: 'allowlist' })
    await expect(allow.sendTransaction({ receiverId: ME, actions } as never)).rejects.toMatchObject({ policy: 'allowlist' })
    await expect(allow.sendTransaction(toBase64(encodeTransaction(built(actions))) as never)).rejects.toMatchObject({ policy: 'allowlist' })
  })

  it('borsh reads on after a delegate: a later AddKey(FullAccess) is in accountChanges, as in object form', async () => {
    const actions = [delegateOf('bob.near', 'bob.near', [{ transfer: { deposit: 1n } }]), addFull] as never as Actions
    const all = await intents(actions)
    for (const i of all) expect(view(i)).toEqual({ d: ['alice.near', 'bob.near'], u: true, c: ['delegate', 'add-key', 'full-access-key'] })
  })

  it('borsh reads on after a global-contract action: the later AddKey is reported, the write stays unknown', async () => {
    for (const g of [{ useGlobalContract: { accountId: 'code.near' } }, { useGlobalContract: { codeHash: new Uint8Array(32).fill(7) } }, { deployGlobalContract: { code: new Uint8Array([0, 97, 115, 109]), deployMode: 'accountId' } }]) {
      const all = await intents([g, addFull] as never as Actions)
      for (const i of all) expect(view(i)).toEqual({ d: [ME], u: true, c: ['global-contract', 'add-key', 'full-access-key'] })
    }
  })

  it('a delegate inside a delegate is unknown in both forms', async () => {
    const actions = [delegateOf(ME, ME, [delegateOf(ME, ME, [addFull])])] as never as Actions
    const confirm = vi.fn(async (_i: WriteIntent) => true)
    await applyPolicies(near(), { confirm }, 'near:mainnet').sendTransaction({ receiverId: ME, actions } as never)
    await applyPolicies(near(), { confirm }, 'near:mainnet').sendTransaction(toBase64(encodeTransaction(built(actions))) as never)
    for (const [i] of confirm.mock.calls) expect(i.destinationUnknown).toBe(true)
  })

  it('control: a relayed delegate that only calls ft_transfer reads the same in every form and passes an allowlist naming its receivers', async () => {
    const actions = [delegateOf('bob.near', 'usdc.near', [ftTransfer('carol.near')])] as never as Actions
    const all = await intents(actions, 'bob.near')
    for (const i of all) expect(view(i)).toEqual({ d: ['bob.near', 'carol.near', 'usdc.near'], u: false, c: ['delegate'] })
    const allow = applyPolicies(near(), { allowlist: { near: ['bob.near', 'usdc.near', 'carol.near'] } }, 'near:mainnet')
    await expect(allow.sendTransaction(toBase64(encodeTransaction(built(actions, 'bob.near'))) as never)).resolves.toBeDefined()
    await expect(allow.sendTransaction({ receiverId: 'bob.near', actions } as never)).resolves.toBeDefined()
    // the same delegate paying someone the allowlist does not name is refused in borsh too
    const other = [delegateOf('bob.near', 'usdc.near', [ftTransfer('mallory.near')])] as never as Actions
    await expect(allow.sendTransaction(toBase64(encodeTransaction(built(other, 'bob.near'))) as never)).rejects.toMatchObject({ policy: 'allowlist' })
  })

  it('control: truncated borsh after a delegate is unknown, with the changes read so far', async () => {
    const bytes = encodeTransaction(built([delegateOf(ME, ME, [addFull])] as never as Actions))
    const confirm = vi.fn(async (_i: WriteIntent) => true)
    await applyPolicies(near(), { confirm }, 'near:mainnet').sendTransaction(toBase64(bytes.subarray(0, bytes.length - 10)) as never)
    expect(confirm.mock.calls[0]![0]).toMatchObject({ destinationUnknown: true })
    expect(confirm.mock.calls[0]![0].accountChanges).toContain('delegate')
  })
})

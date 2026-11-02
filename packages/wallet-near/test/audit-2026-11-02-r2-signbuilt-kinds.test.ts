import { describe, expect, it } from 'vitest'
import { WalletManagerNear, type NearAction, type NearBuiltTransaction } from '../src/index.js'
import { ACCOUNT0, SEED, USDT, fakeNode } from './fake-node.js'

// Every dangerous action kind is refused by signBuilt (and signTransaction) unless allowDangerousActions
// is set; ordinary function calls and named accounts still sign.

const K = { keyType: 'ed25519' as const, data: new Uint8Array(32).fill(0xaa) }
const SIG = { keyType: 'ed25519' as const, data: new Uint8Array(64) }

async function acct(cfg: { allowDangerousActions?: boolean } = {}) {
  return new WalletManagerNear(SEED, { provider: fakeNode().fetch, ...cfg }).getAccount(0)
}
const built = (a: { publicKey: NearBuiltTransaction['publicKey']; address: string }, actions: NearAction[], receiverId = ACCOUNT0): NearBuiltTransaction =>
  ({ signerId: a.address, publicKey: a.publicKey, nonce: 42n, receiverId, blockHash: new Uint8Array(32).fill(9), actions })

const KINDS: Array<[string, NearAction]> = [
  ['Stake', { stake: { stake: 1n, publicKey: K } }],
  ['CreateAccount', { createAccount: {} }],
  ['AddKey(FunctionCall with allowance)', { addKey: { publicKey: K, accessKey: { nonce: 0n, permission: { functionCall: { allowance: 10n ** 24n, receiverId: 'x.near', methodNames: [] } } } } }],
  ['SignedDelegate', { signedDelegate: { delegateAction: { senderId: 'bob.near', receiverId: 'x.near', actions: [{ transfer: { deposit: 1n } }], nonce: 1n, maxBlockHeight: 1n, publicKey: K }, signature: SIG } }],
  ['SignedDelegate nesting AddKey', { signedDelegate: { delegateAction: { senderId: 'bob.near', receiverId: 'bob.near', actions: [{ addKey: { publicKey: K, accessKey: { nonce: 0n, permission: { fullAccess: {} } } } }], nonce: 1n, maxBlockHeight: 1n, publicKey: K }, signature: SIG } }],
  ['DeployGlobalContract', { deployGlobalContract: { code: new Uint8Array([0]), deployMode: 'codeHash' } }],
  ['UseGlobalContract', { useGlobalContract: { accountId: 'x.near' } }],
]

describe('NEAR signBuilt: every dangerous action kind', () => {
  for (const [name, action] of KINDS) {
    it(`${name}: refused by signBuilt`, async () => {
      const a = await acct()
      await expect(a.signBuilt(built(a, [action]))).rejects.toMatchObject({ name: 'UnsafeTransactionError', code: 'dangerous-action' })
    })
    it(`${name}: signed with allowDangerousActions`, async () => {
      const a = await acct({ allowDangerousActions: true })
      await expect(a.signBuilt(built(a, [action]))).resolves.toMatchObject({ signature: { keyType: 'ed25519' } })
    })
  }

  it('control: storage_deposit + ft_transfer_call and a named account still sign', async () => {
    const a = await acct()
    const fc = (methodName: string, args: Record<string, unknown>, deposit: bigint): NearAction => ({ functionCall: { methodName, args, gas: 30n * 10n ** 12n, deposit } })
    await expect(a.signBuilt(built(a, [fc('storage_deposit', { account_id: 'intents.near' }, 1250000000000000000000n), fc('ft_transfer_call', { receiver_id: 'intents.near', amount: '1', msg: '' }, 1n)], USDT))).resolves.toBeTruthy()
    const named = a.withAccountId('alice.near')
    await expect(named.signBuilt(built(named, [{ transfer: { deposit: 1n } }], 'bob.near'))).resolves.toBeTruthy()
  })
})

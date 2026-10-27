import { describe, expect, it } from 'vitest'
import { WalletManagerNear, encodeTransaction, toBase64, type NearBuiltTransaction, type NearFetch } from '../src/index.js'
import { ACCOUNT0, SEED, USDT, fakeNode } from './fake-node.js'

// 2026-10-27 key/signing scan: the exploit inputs from the report, refused before anything is signed.

const manager = (f: { fetch: NearFetch }) => new WalletManagerNear(SEED, { provider: f.fetch })

/** A borsh transaction from ACCOUNT0, with the given receiver and actions (built by the package's own encoder). */
async function borsh(receiverId: string, actions: NearBuiltTransaction['actions']): Promise<{ b64: string; bytes: Uint8Array }> {
  const a = await manager(fakeNode()).getAccount(0)
  const bytes = encodeTransaction({ signerId: ACCOUNT0, publicKey: a.publicKey, nonce: 7n, receiverId, blockHash: new Uint8Array(32).fill(9), actions })
  return { b64: toBase64(bytes), bytes }
}

describe('scan 2026-10-27 G5 (F7, F8, F16): a base64 NEAR transaction is signed only as the exact bytes given', () => {
  it('method bytes EF BB BF + ft_transfer are refused (the BOM is not dropped and re-signed as a clean ft_transfer)', async () => {
    const { b64 } = await borsh(USDT, [{ functionCall: { methodName: '﻿ft_transfer', args: { receiver_id: 'drainer.near', amount: '1000000' }, gas: 30n * 10n ** 12n, deposit: 1n } }])
    const f = fakeNode()
    const a = await manager(f).getAccount(0)
    await expect(a.buildTransaction(b64)).rejects.toMatchObject({ name: 'UnsafeTransactionError' })
    await expect(a.signTransaction(b64)).rejects.toMatchObject({ name: 'UnsafeTransactionError' })
    await expect(a.sendTransaction(b64)).rejects.toMatchObject({ name: 'UnsafeTransactionError' })
  })

  it('non-canonical borsh (an Option tag of 2, a global-contract mode of 7) is refused', async () => {
    const { bytes } = await borsh(USDT, [{ addKey: { publicKey: (await manager(fakeNode()).getAccount(0)).publicKey, accessKey: { nonce: 0n, permission: { functionCall: { allowance: 5n, receiverId: USDT, methodNames: ['ft_transfer'] } } } } }])
    const a = await manager(fakeNode()).getAccount(0)
    // The allowance Option tag sits right after the permission tag (0 = FunctionCall).
    const at = bytes.findIndex((_, i) => bytes[i] === 0 && bytes[i + 1] === 1 && bytes[i + 2] === 5 && bytes.slice(i + 3, i + 18).every((b) => b === 0))
    expect(at).toBeGreaterThan(0)
    const bad = bytes.slice(); bad[at + 1] = 2
    await expect(a.buildTransaction(toBase64(bad))).rejects.toThrow()
    const g = await borsh(USDT, [{ deployGlobalContract: { code: new Uint8Array(0), deployMode: 'codeHash' } }])
    const mode = g.bytes.slice(); mode[mode.length - 1] = 7
    await expect(a.buildTransaction(toBase64(mode))).rejects.toThrow()
  })

  it('a canonical transaction decodes and re-encodes unchanged (control)', async () => {
    const { b64, bytes } = await borsh(USDT, [{ functionCall: { methodName: 'ft_transfer', args: { receiver_id: 'friend.near', amount: '1' }, gas: 30n * 10n ** 12n, deposit: 1n } }])
    const a = await manager(fakeNode()).getAccount(0)
    const built = await a.buildTransaction(b64)
    expect(encodeTransaction(built)).toEqual(bytes)
  })
})

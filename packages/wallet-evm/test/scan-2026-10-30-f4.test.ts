import { describe, expect, it } from 'vitest'
import { hexToBytes } from 'viem'
import { externalSigner } from '@anywalletkit/core'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { WalletManagerEvm, describeTypedData } from '../src/index.js'

// Scan 2026-10-30 F4, signer half: an undeclared `details` decoy next to the signed `permitted` does not change
// the EIP-712 signature, so a description that reads the decoy describes something that is not signed. Now
// describeTypedData reads the Permit2 grant only through the declared schema.
const KEY = hexToBytes('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const MAX = (1n << 256n) - 1n
const FUTURE = BigInt(Math.floor(Date.now() / 1000) + 3600)
const typed = (extra: Record<string, unknown>, amount = 10n ** 30n) => ({
  domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
  primaryType: 'PermitTransferFrom',
  types: {
    PermitTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
    TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
  },
  message: { permitted: { token: USDC, amount }, spender: '0x00000000000000000000000000000000000000aa', nonce: 0n, deadline: FUTURE, ...extra },
})
const codes = (t: unknown) => describeTypedData(t as never).warnings.map((w) => w.code)

describe('scan 2026-10-30 F4: the Permit2 description is what gets signed', () => {
  it('undeclared fields are not signed (control: the signature with the decoy equals the one without)', async () => {
    const signer = externalSigner({ curve: 'secp256k1', publicKey: secp256k1.getPublicKey(KEY), sign: async (p) => {
      const r = secp256k1.sign(p, KEY, { prehash: false, format: 'recovered' }); const o = new Uint8Array(65); o.set(r.subarray(1)); o[64] = r[0]!; return o } })
    const a = await new WalletManagerEvm(signer, {}).getAccount()
    const withDecoy = await a.signTypedData(typed({ details: { token: '0x00000000000000000000000000000000000000cc', amount: 1n } }) as never)
    expect(withDecoy).toBe(await a.signTypedData(typed({}) as never))
  })

  it('an unlimited signed `permitted` is flagged even with a small undeclared `details` decoy', () => {
    expect(codes(typed({ details: { token: USDC, amount: 1n } }, MAX))).toEqual(['approve-unlimited'])
    expect(codes(typed({}, MAX))).toEqual(['approve-unlimited'])
    expect(codes(typed({ details: { token: USDC, amount: MAX } }, 1n))).toEqual([]) // the decoy is not the grant
  })

  it('a schema that is not Permit2’s is the worst case; an undeclared deadline is not read', () => {
    const t = typed({})
    expect(codes({ ...t, types: { ...t.types, TokenPermissions: [{ name: 'token', type: 'address' }] } })).toEqual(['approve-unlimited'])
    expect(codes({ ...t, types: { PermitTransferFrom: t.types.PermitTransferFrom } })).toEqual(['approve-unlimited'])
    expect(codes({ ...t, message: { ...t.message, permitted: [t.message.permitted] } })).toEqual(['approve-unlimited'])
    const noDeadline = { ...t, types: { ...t.types, PermitTransferFrom: t.types.PermitTransferFrom.slice(0, 3) }, message: { ...t.message, deadline: 1n } }
    expect(codes(noDeadline)).toEqual([])
  })
})

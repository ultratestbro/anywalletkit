import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { applyPolicies, type WriteIntent } from '../src/index.js'

// Scan 2026-10-30 F4: a PermitTransferFrom declares only `permitted`, but the policies read an UNDECLARED
// `details` decoy (not part of the EIP-712 hash) as the grant. Now the Permit2 grant is read only through
// the declared schema: the grant field Permit2 uses for the primary type, its struct's declared token /
// amount / expiration, a declared spender and deadline. Any other schema is the worst case.

const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const SPENDER = '0x00000000000000000000000000000000000000aa'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const JUNK = '0x00000000000000000000000000000000000000cc'
const BIG = 10n ** 30n

async function intentOf(arg: unknown): Promise<WriteIntent> {
  let seen: WriteIntent | undefined
  const acc = Object.assign(createMockAccount({ chain: 'eip155:1' }), { signTypedData: async (_t: unknown) => '0xsig' })
  await applyPolicies(acc, { confirm: (i) => { seen = i; return true } }, 'eip155:1').signTypedData(arg as never)
  return seen!
}
const domain = { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 }
const TOKEN_PERMISSIONS = [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }]
const PERMIT_DETAILS = [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }]
const TRANSFER_FROM = [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }]
const SINGLE = [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }]

const decoyTyped = {
  domain, primaryType: 'PermitTransferFrom',
  types: { PermitTransferFrom: TRANSFER_FROM, TokenPermissions: TOKEN_PERMISSIONS },
  message: { permitted: { token: USDC, amount: BIG }, spender: SPENDER, nonce: 0n, deadline: 9n, details: { token: JUNK, amount: 1n } },
}
const single = (types: Record<string, unknown>, message: Record<string, unknown> = {}) => ({
  domain, primaryType: 'PermitSingle', types: { PermitSingle: SINGLE, PermitDetails: PERMIT_DETAILS, ...types },
  message: { details: { token: USDC, amount: 5n, expiration: 7, nonce: 0 }, spender: SPENDER, sigDeadline: 9n, ...message },
})
const WORST = { kind: 'approval', unlimited: true, approvals: [] }

describe('scan 2026-10-30 F4: the Permit2 grant is what gets signed', () => {
  it('PermitTransferFrom with an undeclared `details` decoy reports the signed `permitted`', async () => {
    const i = await intentOf(decoyTyped)
    expect(i.approvals).toEqual([{ token: USDC, amount: BIG, unlimited: false }])
    expect(i).toMatchObject({ kind: 'approval', to: SPENDER, token: USDC, amount: BIG, unlimited: false, deadline: 9n })
  })

  it('control: the same message without the decoy', async () => {
    const { details: _d, ...msg } = decoyTyped.message
    expect(await intentOf({ ...decoyTyped, message: msg })).toMatchObject({ token: USDC, amount: BIG, unlimited: false })
  })

  it('PermitSingle with an undeclared `permitted` decoy reports the signed `details`', async () => {
    const i = await intentOf(single({}, { permitted: { token: JUNK, amount: 1n } }))
    expect(i).toMatchObject({ kind: 'approval', to: SPENDER, token: USDC, amount: 5n, unlimited: false, deadline: 9n })
  })

  it('an undeclared field inside the entry is ignored', async () => {
    const i = await intentOf(single({}, { details: { token: USDC, amount: 5n, expiration: 7, nonce: 0, extra: 1 } }))
    expect(i).toMatchObject({ token: USDC, amount: 5n })
  })

  it('schemas that are not Permit2’s are the worst case', async () => {
    // amount declared with another type than Permit2 signs
    expect(await intentOf(single({ PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint8' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] }))).toMatchObject(WORST)
    // amount not declared at all
    expect(await intentOf(single({ PermitDetails: [{ name: 'token', type: 'address' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] }))).toMatchObject(WORST)
    // the grant field declared as a list on a single permit, and the message a list
    expect(await intentOf(single({ PermitSingle: [{ name: 'details', type: 'PermitDetails[]' }, ...SINGLE.slice(1)] }, { details: [{ token: USDC, amount: 5n, expiration: 0, nonce: 0 }] }))).toMatchObject(WORST)
    // declared single, message a list
    expect(await intentOf(single({}, { details: [{ token: USDC, amount: 5n, expiration: 0, nonce: 0 }] }))).toMatchObject(WORST)
    // the transfer-permit field on an allowance permit
    expect(await intentOf(single({ PermitSingle: [{ name: 'permitted', type: 'TokenPermissions' }, ...SINGLE.slice(1)], TokenPermissions: TOKEN_PERMISSIONS }, { permitted: { token: USDC, amount: 5n } }))).toMatchObject(WORST)
    // both grant fields declared
    expect(await intentOf(single({ PermitSingle: [...SINGLE, { name: 'permitted', type: 'TokenPermissions' }], TokenPermissions: TOKEN_PERMISSIONS }, { permitted: { token: USDC, amount: 5n } }))).toMatchObject(WORST)
  })

  it('an undeclared spender is not signed: the spender is unknown, an allowlist refuses', async () => {
    const typed = single({ PermitSingle: [SINGLE[0], SINGLE[2]] })
    const i = await intentOf(typed)
    expect(i.to).toBeUndefined()
    expect(i.destinationUnknown).toBe(true)
    const acc = Object.assign(createMockAccount({ chain: 'eip155:1' }), { signTypedData: async (_t: unknown) => '0xsig' })
    await expect(applyPolicies(acc, { allowlist: { 'eip155:1': [SPENDER] } }, 'eip155:1').signTypedData(typed as never)).rejects.toThrow(/allowlist/)
  })

  it('an undeclared deadline is not the expiry', async () => {
    const i = await intentOf(single({ PermitSingle: SINGLE.slice(0, 2) }))
    expect(i.deadline).toBe(7n) // the declared entry expiration
  })

  it('canonical witness and batch transfer permits keep their exact readings', async () => {
    const witness = await intentOf({
      domain, primaryType: 'PermitWitnessTransferFrom',
      types: { PermitWitnessTransferFrom: [...TRANSFER_FROM, { name: 'witness', type: 'Witness' }], TokenPermissions: TOKEN_PERMISSIONS, Witness: [{ name: 'user', type: 'address' }] },
      message: { permitted: { token: USDC, amount: 3n }, spender: SPENDER, nonce: 0n, deadline: 9n, witness: { user: SPENDER } },
    })
    expect(witness).toMatchObject({ kind: 'approval', to: SPENDER, token: USDC, amount: 3n, unlimited: false, deadline: 9n })
    const batch = await intentOf({
      domain, primaryType: 'PermitBatchTransferFrom',
      types: { PermitBatchTransferFrom: [{ name: 'permitted', type: 'TokenPermissions[]' }, ...TRANSFER_FROM.slice(1)], TokenPermissions: TOKEN_PERMISSIONS },
      message: { permitted: [{ token: USDC, amount: 3n }, { token: JUNK, amount: 4n }], spender: SPENDER, nonce: 0n, deadline: 9n },
    })
    expect(batch.approvals).toEqual([{ token: USDC, amount: 3n, unlimited: false }, { token: JUNK, amount: 4n, unlimited: false }])
    expect(batch.token).toBeUndefined()
  })
})

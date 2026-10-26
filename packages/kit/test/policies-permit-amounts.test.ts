import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { applyPolicies, type WriteIntent } from '../src/index.js'

// Audit 2026-10-25 round 3, M3: the approval intent misreported what a signature grants.
// - Permit2 `PermitBatch` showed only `details[0]`; `PermitBatchTransferFrom` showed no amount.
// - Amount strings the signer reads through BigInt() (' 0x…', '0X…', '0b…') were "not a number"
//   to the policies, so a max-uint allowance spelled that way was not `unlimited`.
// - Unlimited is now one threshold for the whole SDK: type(uint128).max and above.

const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const SPENDER = '0x00000000000000000000000000000000000000aa'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f'
const MAX = (1n << 256n) - 1n

async function intentOf(method: string, arg: unknown): Promise<WriteIntent> {
  let seen: WriteIntent | undefined
  const acc = Object.assign(createMockAccount({ chain: 'eip155:1' }), {
    signTypedData: async () => '0xsig', signPermit: async () => '0xsig', approve: async () => ({ hash: '0x1', fee: 0n }),
  })
  const g = applyPolicies(acc, { confirm: (i) => { seen = i; return true } }, 'eip155:1') as unknown as Record<string, (a: unknown) => Promise<unknown>>
  await g[method]!(arg)
  return seen!
}

const permit2 = (primaryType: string, types: Record<string, unknown>, message: Record<string, unknown>) => ({
  domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 }, primaryType, types, message,
})
const TOKEN_PERMISSIONS = [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }]
const DETAILS = [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }]

describe('Permit2: every token of a batch is read', () => {
  it('PermitBatch: an unlimited second entry makes the intent unlimited and is listed', async () => {
    const i = await intentOf('signTypedData', permit2('PermitBatch',
      { PermitBatch: [{ name: 'details', type: 'PermitDetails[]' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }], PermitDetails: DETAILS },
      { details: [{ token: USDC, amount: 1n, expiration: 0, nonce: 0 }, { token: DAI, amount: (1n << 160n) - 1n, expiration: 0, nonce: 0 }], spender: SPENDER, sigDeadline: 9n }))
    expect(i).toMatchObject({ kind: 'approval', to: SPENDER, unlimited: true })
    expect(i.approvals).toEqual([{ token: USDC, amount: 1n, unlimited: false }, { token: DAI, amount: (1n << 160n) - 1n, unlimited: true }])
    expect(i.token).toBeUndefined() // several tokens: no single token to name
  })

  it('PermitBatchTransferFrom: amounts of every permitted entry', async () => {
    const i = await intentOf('signTypedData', permit2('PermitBatchTransferFrom',
      { PermitBatchTransferFrom: [{ name: 'permitted', type: 'TokenPermissions[]' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }], TokenPermissions: TOKEN_PERMISSIONS },
      { permitted: [{ token: USDC, amount: MAX }], spender: SPENDER, nonce: 0n, deadline: 9n }))
    expect(i).toMatchObject({ kind: 'approval', token: USDC, amount: MAX, unlimited: true })
    expect(i.approvals).toEqual([{ token: USDC, amount: MAX, unlimited: true }])
  })

  it('PermitSingle still reads its one entry', async () => {
    const i = await intentOf('signTypedData', permit2('PermitSingle',
      { PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }], PermitDetails: DETAILS },
      { details: { token: USDC, amount: 5n, expiration: 0, nonce: 0 }, spender: SPENDER, sigDeadline: 9n }))
    expect(i).toMatchObject({ token: USDC, amount: 5n, unlimited: false })
  })
})

describe('amounts are read the way the signer reads them (BigInt)', () => {
  const spellings = [` 0x${'f'.repeat(64)}`, `0X${'f'.repeat(64)}`, `0b${'1'.repeat(256)}`, `0o${'7'.repeat(85)}1`, `${MAX}\n`]
  for (const s of spellings) {
    it(`approve / signPermit / EIP-2612 with ${JSON.stringify(s.slice(0, 6))}… is unlimited`, async () => {
      expect(await intentOf('approve', { token: USDC, spender: SPENDER, amount: s })).toMatchObject({ unlimited: true })
      expect(await intentOf('signPermit', { token: USDC, spender: SPENDER, value: s, deadline: 9n })).toMatchObject({ unlimited: true })
      const permit = await intentOf('signTypedData', {
        domain: { name: 'USD Coin', chainId: 1, verifyingContract: USDC }, primaryType: 'Permit',
        types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
        message: { owner: SPENDER, spender: SPENDER, value: s, nonce: 0, deadline: 9 },
      })
      expect(permit).toMatchObject({ kind: 'approval', unlimited: true })
    })
  }

  it('an EIP-2612 Permit whose value is not a declared uint256 is unlimited (worst case)', async () => {
    const permit = (fields: Array<{ name: string; type: string }>, message: Record<string, unknown>) => intentOf('signTypedData', {
      domain: { name: 'T', chainId: 1, verifyingContract: USDC }, primaryType: 'Permit', types: { Permit: fields }, message,
    })
    const base = [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }]
    expect(await permit([...base, { name: 'value', type: 'uint' }], { owner: SPENDER, spender: SPENDER, value: 1, nonce: 0, deadline: 9 })).toMatchObject({ unlimited: true })
    expect(await permit(base, { owner: SPENDER, spender: SPENDER, value: 1, nonce: 0, deadline: 9 })).toMatchObject({ unlimited: true })
    expect(await permit([...base, { name: 'value', type: 'uint256' }], { owner: SPENDER, spender: SPENDER, value: 1, nonce: 0, deadline: 9 })).toMatchObject({ unlimited: false, amount: 1n })
  })

  it('an amount the policies cannot read counts as unlimited (worst case shown)', async () => {
    expect(await intentOf('approve', { token: USDC, spender: SPENDER, amount: { valueOf: () => 1 } })).toMatchObject({ unlimited: true })
    expect(await intentOf('approve', { token: USDC, spender: SPENDER, amount: 1.5 })).toMatchObject({ unlimited: true })
  })
})

describe('one unlimited threshold: type(uint128).max and above', () => {
  it('uint128 max is unlimited, 2^127 is not', async () => {
    expect(await intentOf('approve', { token: USDC, spender: SPENDER, amount: (1n << 128n) - 1n })).toMatchObject({ unlimited: true })
    expect(await intentOf('approve', { token: USDC, spender: SPENDER, amount: 1n << 127n })).toMatchObject({ unlimited: false, amount: 1n << 127n })
  })
})

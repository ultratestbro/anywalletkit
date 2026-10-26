import { describe, expect, it } from 'vitest'
import { encodeFunctionData, maxUint256, type Hex } from 'viem'
import { ERC20_ABI, describeTransaction, describeTypedData } from '../src/index.js'

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const EVIL = '0x000000000000000000000000000000000000bEEF'
const ME = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const AUTH = { chainId: 1, address: '0x000000000000000000000000000000000000de1e' as Hex, nonce: 0, r: ('0x' + '11'.repeat(32)) as Hex, s: ('0x' + '22'.repeat(32)) as Hex, yParity: 0 }
const future = BigInt(Math.floor(Date.now() / 1000) + 3600)

// Audit 2026-10-25 round 3, L12: a type 4 transaction was described only as a delegation; an
// approve(EVIL, max) riding in its calldata was not decoded and raised no warning.
describe('describeTransaction: the call inside an EIP-7702 transaction', () => {
  it('decodes the approval and warns about it, next to the delegation', () => {
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [EVIL, maxUint256] })
    const d = describeTransaction({ type: 4, to: USDC, data, authorizationList: [AUTH] })
    expect(d).toMatchObject({ kind: 'eip7702-delegation', call: 'erc20-approve', token: USDC, spender: EVIL, amount: maxUint256, delegations: [{ chainId: 1 }] })
    expect(d.warnings.map((w) => w.code)).toContain('approve-unlimited')
  })
  it('a bare delegation (no calldata to the account itself) still says what the call is', () => {
    expect(describeTransaction({ type: 4, to: ME, authorizationList: [AUTH] })).toMatchObject({ kind: 'eip7702-delegation', call: 'native-transfer' })
  })
})

// L13: hex chainId was not read; Permit2 SignatureTransfer (`permitted`) was never flagged
// unlimited; a DAI-style permit (`allowed: true`) was 'generic'.
describe('describeTypedData', () => {
  it('reads a hex domain chainId (and warns on a mismatch)', () => {
    const d = describeTypedData({ domain: { name: 'X', chainId: '0x2105' }, types: { M: [{ name: 'v', type: 'uint256' }] }, primaryType: 'M', message: { v: 1 } }, { chainId: 1 })
    expect(d.domain.chainId).toBe(8453)
    expect(d.warnings.map((w) => w.code)).toContain('chain-mismatch')
  })

  it('Permit2 PermitTransferFrom / PermitBatchTransferFrom with a max amount are unlimited', () => {
    const tp = [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }]
    const single = describeTypedData({
      domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
      types: { PermitTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }], TokenPermissions: tp },
      primaryType: 'PermitTransferFrom',
      message: { permitted: { token: USDC, amount: maxUint256.toString() }, spender: EVIL, nonce: '1', deadline: future.toString() },
    })
    expect(single.kind).toBe('permit2')
    expect(single.warnings.map((w) => w.code)).toContain('approve-unlimited')
    const batch = describeTypedData({
      domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
      types: { PermitBatchTransferFrom: [{ name: 'permitted', type: 'TokenPermissions[]' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }], TokenPermissions: tp },
      primaryType: 'PermitBatchTransferFrom',
      message: { permitted: [{ token: USDC, amount: '5' }, { token: DAI, amount: (2n ** 160n - 1n).toString() }], spender: EVIL, nonce: '1', deadline: future.toString() },
    })
    expect(batch.warnings.map((w) => w.code)).toContain('approve-unlimited')
    const bounded = describeTypedData({ ...single, domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 }, types: { PermitTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }], TokenPermissions: tp }, primaryType: 'PermitTransferFrom', message: { permitted: { token: USDC, amount: '5' }, spender: EVIL, nonce: '1', deadline: future.toString() } })
    expect(bounded.warnings.map((w) => w.code)).not.toContain('approve-unlimited')
  })

  it("a DAI-style permit (holder / allowed) is a permit; allowed: true is an unlimited approval", () => {
    const types = { Permit: [{ name: 'holder', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'expiry', type: 'uint256' }, { name: 'allowed', type: 'bool' }] }
    const d = describeTypedData({ domain: { name: 'Dai Stablecoin', version: '1', chainId: 1, verifyingContract: DAI }, types, primaryType: 'Permit', message: { holder: ME, spender: EVIL, nonce: '0', expiry: '0', allowed: true } }, { account: ME })
    expect(d).toMatchObject({ kind: 'permit', permit: { owner: ME, spender: EVIL, value: maxUint256, deadline: 0n } })
    expect(d.warnings.map((w) => w.code)).toEqual(['approve-unlimited']) // expiry 0 = no deadline in DAI, not a passed one
    const revoke = describeTypedData({ domain: { name: 'Dai Stablecoin', version: '1', chainId: 1, verifyingContract: DAI }, types, primaryType: 'Permit', message: { holder: ME, spender: EVIL, nonce: '0', expiry: future.toString(), allowed: false } }, { account: ME })
    expect(revoke).toMatchObject({ kind: 'permit', permit: { value: 0n } })
    expect(revoke.warnings).toEqual([])
  })
})

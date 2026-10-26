import { describe, expect, it } from 'vitest'
import { encodeFunctionData, maxUint256, type Hex } from 'viem'
import { ERC20_ABI, describeTransaction } from '../src/index.js'

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const EVIL = '0x000000000000000000000000000000000000bEEF'
const ME = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const AUTH = { chainId: 1, address: '0x000000000000000000000000000000000000de1e' as Hex, nonce: 0, r: ('0x' + '11'.repeat(32)) as Hex, s: ('0x' + '22'.repeat(32)) as Hex, yParity: 0 }

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

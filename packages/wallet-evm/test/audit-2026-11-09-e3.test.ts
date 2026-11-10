import { describe, expect, it } from 'vitest'
import { encodeFunctionData, type Hex } from 'viem'
import { ERC20_ABI, describeTypedData } from '../src/index.js'

// Extension audit 2026-11-09 E3: Permit2, Seaport and SafeTx typed data came back with no spender, no amounts
// and no operation, so a sheet built on the description had nothing to warn about. Every asset-granting form is
// now decoded as a grant, and the drainer shapes carry warnings.
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const ME = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const ATTACKER = '0x000000000000000000000000000000000000bEEF'
const ROUTER = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af'
const SAFE = '0x1111111111111111111111111111111111111111'
const NFT = '0x2222222222222222222222222222222222222222'
const FEE = '0x0000a26b00c1F0DF003000390027140000fAa719'
const future = BigInt(Math.floor(Date.now() / 1000) + 3600)
const codes = (d: { warnings: Array<{ code: string }> }) => d.warnings.map((w) => w.code)

const TOKEN_PERMISSIONS = [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }]
const transferFrom = (spender: string, amount: bigint) => ({
  domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
  primaryType: 'PermitTransferFrom',
  types: {
    PermitTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
    TokenPermissions: TOKEN_PERMISSIONS,
  },
  message: { permitted: { token: USDC, amount }, spender, nonce: 7n, deadline: future },
})

describe('E3: Permit2 is described as a grant', () => {
  it('PermitTransferFrom of the whole USDC balance to an attacker: spender, token, amount, deadline and a spender warning', () => {
    const d = describeTypedData(transferFrom(ATTACKER, 1_234_560_000n), { chainId: 1, account: ME })
    expect(d.kind).toBe('permit2')
    expect(d.permit2).toMatchObject({ spender: ATTACKER, transfer: true, deadline: future, nonce: 7n, entries: [{ token: USDC, amount: 1_234_560_000n }] })
    expect(codes(d)).toContain('spender-unknown')
    expect(d.warnings.find((w) => w.code === 'spender-unknown')!.message).toContain(ATTACKER)
  })

  it('a spender the caller lists as known carries its label and no spender warning', () => {
    const d = describeTypedData(transferFrom(ROUTER, 5n), { chainId: 1, account: ME, knownSpenders: { [ROUTER.toUpperCase().replace('0X', '0x')]: 'Uniswap Universal Router' } })
    expect(d.permit2).toMatchObject({ spender: ROUTER, spenderLabel: 'Uniswap Universal Router' })
    expect(codes(d)).not.toContain('spender-unknown')
  })

  it('PermitSingle / PermitBatch (AllowanceTransfer): every entry with its expiration, sigDeadline, standing allowance', () => {
    const details = [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }]
    const d = describeTypedData({
      domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
      primaryType: 'PermitBatch',
      types: { PermitBatch: [{ name: 'details', type: 'PermitDetails[]' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }], PermitDetails: details },
      message: { details: [{ token: USDC, amount: 10n, expiration: 1900000000, nonce: 0 }, { token: WETH, amount: (1n << 160n) - 1n, expiration: 1900000001, nonce: 3 }], spender: ATTACKER, sigDeadline: future },
    }, { chainId: 1, account: ME })
    expect(d.permit2).toMatchObject({ spender: ATTACKER, transfer: false, deadline: future, entries: [{ token: USDC, amount: 10n, expiration: 1900000000n, nonce: 0n }, { token: WETH, amount: (1n << 160n) - 1n, expiration: 1900000001n, nonce: 3n }] })
    expect(codes(d)).toEqual(expect.arrayContaining(['approve-unlimited', 'spender-unknown']))
  })

  it('PermitWitnessTransferFrom names its witness type', () => {
    const t = transferFrom(ATTACKER, 1n)
    const d = describeTypedData({
      ...t,
      primaryType: 'PermitWitnessTransferFrom',
      types: { PermitWitnessTransferFrom: [...t.types.PermitTransferFrom, { name: 'witness', type: 'ExclusiveDutchOrder' }], TokenPermissions: TOKEN_PERMISSIONS, ExclusiveDutchOrder: [{ name: 'x', type: 'uint256' }] },
      message: { ...t.message, witness: { x: 1n } },
    })
    expect(d.permit2).toMatchObject({ witness: 'ExclusiveDutchOrder', transfer: true })
  })

  it('an EIP-2612 permit to an unknown spender is warned about too', () => {
    const d = describeTypedData({
      domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC },
      primaryType: 'Permit',
      types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      message: { owner: ME, spender: ATTACKER, value: 100n, nonce: 0n, deadline: future },
    }, { chainId: 1, account: ME })
    expect(codes(d)).toEqual(['spender-unknown'])
  })
})

const OFFER_ITEM = [{ name: 'itemType', type: 'uint8' }, { name: 'token', type: 'address' }, { name: 'identifierOrCriteria', type: 'uint256' }, { name: 'startAmount', type: 'uint256' }, { name: 'endAmount', type: 'uint256' }]
const SEAPORT_TYPES = {
  OrderComponents: [
    { name: 'offerer', type: 'address' }, { name: 'zone', type: 'address' }, { name: 'offer', type: 'OfferItem[]' }, { name: 'consideration', type: 'ConsiderationItem[]' },
    { name: 'orderType', type: 'uint8' }, { name: 'startTime', type: 'uint256' }, { name: 'endTime', type: 'uint256' }, { name: 'zoneHash', type: 'bytes32' },
    { name: 'salt', type: 'uint256' }, { name: 'conduitKey', type: 'bytes32' }, { name: 'counter', type: 'uint256' },
  ],
  OfferItem: OFFER_ITEM,
  ConsiderationItem: [...OFFER_ITEM, { name: 'recipient', type: 'address' }],
}
const order = (consideration: Array<Record<string, unknown>>) => ({
  domain: { name: 'Seaport', version: '1.6', chainId: 1, verifyingContract: '0x0000000000000068F116a894984e2DB1123eB395' },
  primaryType: 'OrderComponents',
  types: SEAPORT_TYPES,
  message: {
    offerer: ME, zone: '0x0000000000000000000000000000000000000000',
    offer: [{ itemType: 2, token: NFT, identifierOrCriteria: 42n, startAmount: 1n, endAmount: 1n }, { itemType: 1, token: USDC, identifierOrCriteria: 0n, startAmount: 500n, endAmount: 500n }],
    consideration, orderType: 0, startTime: 0n, endTime: future, zoneHash: `0x${'00'.repeat(32)}`, salt: 1n, conduitKey: `0x${'00'.repeat(32)}`, counter: 0n,
  },
})

describe('E3: Seaport orders are decoded', () => {
  it('consideration paid to an attacker (nothing back to the signer) is warned about', () => {
    const d = describeTypedData(order([{ itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: 0n, startAmount: 1n, endAmount: 1n, recipient: ATTACKER }]), { chainId: 1, account: ME })
    expect(d.kind).toBe('seaport')
    expect(d.seaport).toMatchObject({ orders: 1, offerer: ME, offer: [{ kind: 'erc721', token: NFT, identifier: 42n, startAmount: 1n }, { kind: 'erc20', token: USDC, startAmount: 500n }], consideration: [{ kind: 'native', recipient: ATTACKER }] })
    expect(codes(d)).toContain('consideration-foreign')
    expect(d.warnings.find((w) => w.code === 'consideration-foreign')!.message).toMatch(/nothing/i)
  })

  it('an honest listing (most of the price back to the signer) still names the other recipients', () => {
    const d = describeTypedData(order([
      { itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: 0n, startAmount: 975n, endAmount: 975n, recipient: ME },
      { itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: 0n, startAmount: 25n, endAmount: 25n, recipient: FEE },
    ]), { chainId: 1, account: ME })
    const w = d.warnings.find((x) => x.code === 'consideration-foreign')
    expect(w?.message).toContain(FEE)
    expect(w?.message).not.toMatch(/nothing/i)
  })

  it('an order for another offerer is an owner mismatch; a bulk order is flattened', () => {
    const one = order([{ itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: 0n, startAmount: 1n, endAmount: 1n, recipient: ATTACKER }])
    expect(codes(describeTypedData({ ...one, message: { ...one.message, offerer: ATTACKER } }, { account: ME }))).toContain('owner-mismatch')
    const bulk = describeTypedData({ domain: one.domain, primaryType: 'BulkOrder', types: { BulkOrder: [{ name: 'tree', type: 'OrderComponents[2]' }], ...SEAPORT_TYPES }, message: { tree: [one.message, one.message] } }, { chainId: 1, account: ME })
    expect(bulk.kind).toBe('seaport')
    expect(bulk.seaport?.orders).toBe(2)
    expect(bulk.seaport?.offer).toHaveLength(4)
    expect(codes(bulk)).toContain('consideration-foreign')
  })
})

const SAFE_TX_TYPES = { SafeTx: [
  { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
  { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' }, { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
  { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
] }
const safeTx = (operation: unknown, data: Hex = '0x', to = ATTACKER) => ({
  domain: { chainId: 1, verifyingContract: SAFE }, primaryType: 'SafeTx', types: SAFE_TX_TYPES,
  message: { to, value: 0n, data, operation, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: '0x0000000000000000000000000000000000000000', refundReceiver: '0x0000000000000000000000000000000000000000', nonce: 5n },
})

describe('E3: SafeTx is decoded', () => {
  it('operation 1 (DELEGATECALL) is warned about, with to / value / data / operation shown', () => {
    const d = describeTypedData(safeTx(1, '0xdeadbeef'), { chainId: 1 })
    expect(d.kind).toBe('safe-tx')
    expect(d.safeTx).toMatchObject({ to: ATTACKER, value: 0n, data: '0xdeadbeef', operation: 1, nonce: 5n })
    expect(codes(d)).toContain('safe-delegatecall')
  })

  it('an unreadable operation is the worst case; a plain CALL is not warned about', () => {
    expect(codes(describeTypedData(safeTx('lots')))).toContain('safe-delegatecall')
    expect(codes(describeTypedData(safeTx(0)))).not.toContain('safe-delegatecall')
  })

  it('the inner call is decoded (an ERC-20 transfer out of the Safe)', () => {
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [ATTACKER, 99n] })
    expect(describeTypedData(safeTx(0, data, USDC)).safeTx?.call).toMatchObject({ kind: 'erc20-transfer', token: USDC, recipient: ATTACKER, amount: 99n })
  })
})

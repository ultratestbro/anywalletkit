import { describe, expect, it } from 'vitest'
import { activityBase, netTransfers, sameAddress, splitNet, type ChainTx } from '../src/index.js'
import { ProtocolBase } from '../src/protocols/base.js'
import type { IWalletAccountReadOnly } from '../src/index.js'

const readOnly: IWalletAccountReadOnly = {
  chain: 'eip155:1', getAddress: async () => '0x000000000000000000000000000000000000dEaD', getBalance: async () => 0n, getTokenBalance: async () => 0n,
  quoteSendTransaction: async () => ({ fee: 0n }), quoteTransfer: async () => ({ fee: 0n }), getTransactionReceipt: async () => undefined, verify: async () => false,
}

const own = new Set(['0x000000000000000000000000000000000000dead'])
const tx: ChainTx = {
  chain: 'eip155:8453', hash: '0x01', time: 1_700_000_000, status: 'confirmed',
  address: '0x000000000000000000000000000000000000dEaD', from: '0x000000000000000000000000000000000000dEaD', to: '0xpool',
  nativeValue: 0n,
  transfers: [
    { token: '0xusdc', from: '0x000000000000000000000000000000000000dEaD', to: '0xpool', amount: 100n, standard: 'erc20' },
    { token: '0xausdc', from: '0x0000000000000000000000000000000000000000', to: '0x000000000000000000000000000000000000dEaD', amount: 100n, standard: 'erc20' },
    { token: '0xusdc', from: '0xpool', to: '0xsomeoneelse', amount: 5n, standard: 'erc20' },
  ],
  fee: 7n,
}

describe('history helpers', () => {
  it('sameAddress ignores EVM case only', () => {
    expect(sameAddress('0xAbC', '0xabc')).toBe(true)
    expect(sameAddress('EQabc', 'eqabc')).toBe(false)
    expect(sameAddress(null, '0xabc')).toBe(false)
  })
  it('netTransfers nets per token from the owner view, ignoring third-party legs', () => {
    const net = netTransfers(tx, own)
    expect(net.get('0xusdc')).toBe(-100n)
    expect(net.get('0xausdc')).toBe(100n)
    expect(net.has(null)).toBe(false)
  })
  it('splitNet turns the net map into in / out lists with metadata', () => {
    const { assetsIn, assetsOut } = splitNet(netTransfers(tx, own), (t) => (t === '0xusdc' ? { symbol: 'USDC', decimals: 6 } : undefined))
    expect(assetsOut).toEqual([{ token: '0xusdc', amount: 100n, symbol: 'USDC', decimals: 6 }])
    expect(assetsIn).toEqual([{ token: '0xausdc', amount: 100n }])
  })
  it('activityBase carries id, status and fee', () => {
    const a = activityBase(tx, 'supply', 'Supplied USDC', { protocol: 'x' })
    expect(a.id).toBe('eip155:8453:0x01')
    expect(a.fee).toBe(7n)
    expect(a.kind).toBe('supply')
    expect(a.protocol).toBe('x')
  })
  it('ProtocolBase.describeActivity defaults to null', () => {
    class P extends ProtocolBase<Record<string, never>> {}
    const p = new P(readOnly, {})
    expect(p.describeActivity(tx, { own })).toBeNull()
  })
})

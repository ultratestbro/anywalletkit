import { describe, expect, it } from 'vitest'
import {
  ApprovalsProtocol, BridgeProtocol, FiatProtocol, LendingProtocol, NotImplementedError,
  ReadOnlyAccountError, StakingProtocol, SwapProtocol, Swap2Protocol,
  type IWalletAccountReadOnly, type Swap2Quote, type Swap2Result,
} from '../src/index.js'

const readOnly: IWalletAccountReadOnly = {
  chain: 'eip155:1',
  getAddress: async () => '0x000000000000000000000000000000000000dEaD',
  getBalance: async () => 0n,
  getTokenBalance: async () => 0n,
  quoteSendTransaction: async () => ({ fee: 0n }),
  quoteTransfer: async () => ({ fee: 0n }),
  getTransactionReceipt: async () => undefined,
  verify: async () => false,
}

describe('protocol base classes', () => {
  it('every base method throws NotImplementedError, never returns undefined', async () => {
    type AnyCtor = new (account: IWalletAccountReadOnly) => object
    const bases: AnyCtor[] = [SwapProtocol, BridgeProtocol, Swap2Protocol, LendingProtocol, StakingProtocol, ApprovalsProtocol, FiatProtocol]
    for (const Base of bases) {
      const p = new Base(readOnly) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
      const methods = Object.getOwnPropertyNames(Base.prototype).filter((m) => m !== 'constructor')
      expect(methods.length).toBeGreaterThan(0)
      for (const m of methods) {
        if (Base === Swap2Protocol && ['swap', 'quoteSwap', 'bridge', 'quoteBridge'].includes(m)) continue // derived, tested below
        await expect(p[m]!({})).rejects.toBeInstanceOf(NotImplementedError)
      }
    }
  })

  it('Swap2Protocol derives swap/bridge from swap2', async () => {
    class Fake extends Swap2Protocol {
      override async quoteSwap2(): Promise<Swap2Quote> {
        return { fromTokenAmount: 100n, toTokenAmount: 90n, toTokenAmountMin: 89n, fees: [
          { type: 'network', amount: 3n, token: 'ETH' }, { type: 'protocol', amount: 2n, token: 'ETH' }, { type: 'affiliate', amount: 1n, token: 'ETH' },
        ] }
      }
      override async swap2(): Promise<Swap2Result> {
        const q = await this.quoteSwap2()
        return { id: 'op-1', ...q }
      }
    }
    const p = new Fake(readOnly)
    expect(await p.quoteSwap({ tokenIn: 'a', tokenOut: 'b', tokenInAmount: 100n })).toEqual({ fee: 6n, tokenInAmount: 100n, tokenOutAmount: 90n })
    expect(await p.swap({ tokenIn: 'a', tokenOut: 'b', tokenInAmount: 100n })).toEqual({ hash: 'op-1', fee: 6n, tokenInAmount: 100n, tokenOutAmount: 90n })
    expect(await p.quoteBridge({ token: 'a', targetChain: 'arbitrum', recipient: 'r', amount: 100n })).toEqual({ fee: 3n, bridgeFee: 2n })
    expect(await p.bridge({ token: 'a', targetChain: 'arbitrum', recipient: 'r', amount: 100n })).toEqual({ hash: 'op-1', fee: 3n, bridgeFee: 2n })
  })

  it('requireSigningAccount names the method in ReadOnlyAccountError', () => {
    class Fake extends LendingProtocol { probe() { return this.requireSigningAccount('supply') } }
    expect(() => new Fake(readOnly).probe()).toThrow(ReadOnlyAccountError)
    expect(() => new Fake(readOnly).probe()).toThrow(/'supply'/)
  })
})

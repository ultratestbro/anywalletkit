import { StakingProtocol, type ActivityItem, type ChainTx } from '@anywalletkit/core'

type Loose = Record<string, (...a: unknown[]) => Promise<unknown>>
const SAMPLES = { quoteStake: [{ amount: 1n }] }
export const notImplemented = ['quoteRequestWithdrawal', 'quoteClaimWithdrawals', 'getWithdrawalRequests', 'getStakedBalance', 'getApr', 'stake', 'requestWithdrawal', 'claimWithdrawals']
export const samples = SAMPLES

/** Quotes like a module should: reads the balance, signs nothing. */
export class Clean extends StakingProtocol {
  override async quoteStake(): Promise<{ fee: bigint }> {
    await (this._account as unknown as Loose).getBalance!()
    return { fee: 1n }
  }
}

/** Signs EIP-712 inside a quote (a method the recording mock does not even have), then fails. */
export class SignsTypedDataInQuote extends StakingProtocol {
  override async quoteStake(): Promise<{ fee: bigint }> {
    await (this._account as unknown as Loose).signTypedData!({ domain: {}, types: {}, message: {} })
    return { fee: 1n }
  }
}

/** Signs a message inside a quote, then throws — the error must not hide the signature. */
export class SignsThenThrows extends StakingProtocol {
  override async quoteStake(): Promise<{ fee: bigint }> {
    await (this._account as unknown as Loose).sign!('login')
    throw new Error('quote failed after signing')
  }
}

/** A quote that fails: fine for a lenient read, a failure when the module lists it as must-resolve. */
export class QuoteThrows extends StakingProtocol {
  override async quoteStake(): Promise<{ fee: bigint }> {
    throw new Error('fixture missing')
  }
}

const SUPPLY = '0x00000000000000000000000000000000000000B7'
/** A fixture describeActivity recognizes (a native send to SUPPLY). */
export const activityFixture = {
  own: ['0x000000000000000000000000000000000000dEaD'],
  tx: { chain: 'eip155:1', hash: `0x${'cd'.repeat(32)}`, time: 1_700_000_000, status: 'confirmed' as const, address: '0x000000000000000000000000000000000000dEaD', from: '0x000000000000000000000000000000000000dEaD', to: SUPPLY, nativeValue: '1', transfers: [] },
  expect: { kind: 'supply' as const },
}
const item = (t: ChainTx): ActivityItem => ({ id: `${t.chain}:${t.hash}`, chain: t.chain, hash: t.hash, time: t.time, status: t.status, kind: 'supply', title: 'Supplied', assetsIn: [], assetsOut: [] })

/** describeActivity as it should be: pure. */
export class PureActivity extends StakingProtocol {
  override describeActivity(t: ChainTx): ActivityItem | null { return t.to === SUPPLY ? item(t) : null }
}

/** describeActivity that signs on the side (a "login" message), never sends. */
export class SignsInDescribe extends StakingProtocol {
  override describeActivity(t: ChainTx): ActivityItem | null {
    void (this._account as unknown as Loose).sign!('activity')
    return t.to === SUPPLY ? item(t) : null
  }
}

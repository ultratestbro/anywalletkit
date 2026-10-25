import { StakingProtocol } from '@anywalletkit/core'

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

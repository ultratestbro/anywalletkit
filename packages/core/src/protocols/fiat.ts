// Base class: every method throws NotImplementedError so a module that forgets
// one fails loudly, never with `undefined is not a function`.
import type { IWalletAccount, IWalletAccountReadOnly } from '../account.js'
import { NotImplementedError } from '../errors.js'
import { ProtocolBase } from './base.js'

/** State of an on-ramp or off-ramp order at the provider. */
export type FiatTransactionStatus = 'in_progress' | 'failed' | 'completed'
/** An order's state and its assets, from {@link IFiatProtocol.getTransactionDetail}. */
export interface FiatTransactionDetail { status: FiatTransactionStatus; cryptoAsset: string; fiatCurrency: string }
/** A crypto asset the provider trades, by its own code and network code. */
export interface SupportedCryptoAsset { code: string; networkCode: string; decimals: number; name?: string }
/** A fiat currency the provider accepts (ISO 4217 code). */
export interface SupportedFiatCurrency { code: string; decimals: number; name?: string }
/** A country the provider serves, and in which directions. */
export interface SupportedCountry { code: string; isBuyAllowed: boolean; isSellAllowed: boolean; name?: string }

/** What to buy, with which currency, and where the crypto goes. */
export interface BuyCommonOptions { cryptoAsset: string; fiatCurrency: string; recipient?: string }
/** Buy exactly `cryptoAmount` (base units). */
export interface BuyExactCryptoAmountOptions { cryptoAmount: bigint | number; fiatAmount?: never }
/** Spend exactly `fiatAmount` (smallest fiat unit). */
export interface BuyWithFiatAmountOptions { fiatAmount: bigint | number; cryptoAmount?: never }
/** An on-ramp request with an exact crypto or an exact fiat amount. */
export type BuyOptions = BuyCommonOptions & (BuyExactCryptoAmountOptions | BuyWithFiatAmountOptions)
/** The provider's checkout URL; open it in a browser or web view. */
export interface BuyResult { buyUrl: string }

/** What to sell, for which currency, and where a failed order refunds. */
export interface SellCommonOptions { cryptoAsset: string; fiatCurrency: string; refundAddress?: string }
/** Sell exactly `cryptoAmount` (base units). */
export interface SellExactCryptoAmountOptions { cryptoAmount: bigint | number; fiatAmount?: never }
/** Receive exactly `fiatAmount` (smallest fiat unit). */
export interface SellForFiatAmountOptions { fiatAmount: bigint | number; cryptoAmount?: never }
/** An off-ramp request with an exact crypto or an exact fiat amount. */
export type SellOptions = SellCommonOptions & (SellExactCryptoAmountOptions | SellForFiatAmountOptions)
/** The provider's checkout URL for the sale. */
export interface SellResult { sellUrl: string }

/** A provider's price for a buy or sell. */
export interface FiatQuote {
  /** Crypto amount, base units. */
  cryptoAmount: bigint
  /** Smallest fiat unit (cents). */
  fiatAmount: bigint
  /** In the smallest fiat unit. */
  fee: bigint
  /** Standard units, as a string ("3000.50" = 1 ETH is 3000.50 USD). */
  rate: string
}

/**
 * Interface for on-ramp and off-ramp providers: quotes, a hosted checkout URL, and order status.
 * The SDK ships no fiat module yet.
 */
export interface IFiatProtocol {
  quoteBuy(options: BuyOptions): Promise<FiatQuote>
  buy(options: BuyOptions): Promise<BuyResult>
  quoteSell(options: SellOptions): Promise<FiatQuote>
  sell(options: SellOptions): Promise<SellResult>
  getTransactionDetail(txId: string): Promise<FiatTransactionDetail>
  getSupportedCryptoAssets(): Promise<SupportedCryptoAsset[]>
  getSupportedFiatCurrencies(): Promise<SupportedFiatCurrency[]>
  getSupportedCountries(): Promise<SupportedCountry[]>
}

/** Base class for fiat on/off-ramp modules. */
export class FiatProtocol<TConfig extends object = Record<string, never>>
  extends ProtocolBase<TConfig>
  implements IFiatProtocol
{
  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: TConfig = {} as TConfig) {
    super(account, config)
  }
  async quoteBuy(_o: BuyOptions): Promise<FiatQuote> { throw new NotImplementedError('quoteBuy(options)') }
  async buy(_o: BuyOptions): Promise<BuyResult> { throw new NotImplementedError('buy(options)') }
  async quoteSell(_o: SellOptions): Promise<FiatQuote> { throw new NotImplementedError('quoteSell(options)') }
  async sell(_o: SellOptions): Promise<SellResult> { throw new NotImplementedError('sell(options)') }
  async getTransactionDetail(_id: string): Promise<FiatTransactionDetail> { throw new NotImplementedError('getTransactionDetail(txId)') }
  async getSupportedCryptoAssets(): Promise<SupportedCryptoAsset[]> { throw new NotImplementedError('getSupportedCryptoAssets()') }
  async getSupportedFiatCurrencies(): Promise<SupportedFiatCurrency[]> { throw new NotImplementedError('getSupportedFiatCurrencies()') }
  async getSupportedCountries(): Promise<SupportedCountry[]> { throw new NotImplementedError('getSupportedCountries()') }
}

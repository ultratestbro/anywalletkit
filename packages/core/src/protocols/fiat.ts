// Base class: every method throws NotImplementedError so a module that forgets
// one fails loudly, never with `undefined is not a function`.
import type { IWalletAccount, IWalletAccountReadOnly } from '../account.js'
import { NotImplementedError } from '../errors.js'
import { ProtocolBase } from './base.js'

export type FiatTransactionStatus = 'in_progress' | 'failed' | 'completed'
export interface FiatTransactionDetail { status: FiatTransactionStatus; cryptoAsset: string; fiatCurrency: string }
export interface SupportedCryptoAsset { code: string; networkCode: string; decimals: number; name?: string }
export interface SupportedFiatCurrency { code: string; decimals: number; name?: string }
export interface SupportedCountry { code: string; isBuyAllowed: boolean; isSellAllowed: boolean; name?: string }

export interface BuyCommonOptions { cryptoAsset: string; fiatCurrency: string; recipient?: string }
export interface BuyExactCryptoAmountOptions { cryptoAmount: bigint | number; fiatAmount?: never }
export interface BuyWithFiatAmountOptions { fiatAmount: bigint | number; cryptoAmount?: never }
export type BuyOptions = BuyCommonOptions & (BuyExactCryptoAmountOptions | BuyWithFiatAmountOptions)
export interface BuyResult { buyUrl: string }

export interface SellCommonOptions { cryptoAsset: string; fiatCurrency: string; refundAddress?: string }
export interface SellExactCryptoAmountOptions { cryptoAmount: bigint | number; fiatAmount?: never }
export interface SellForFiatAmountOptions { fiatAmount: bigint | number; cryptoAmount?: never }
export type SellOptions = SellCommonOptions & (SellExactCryptoAmountOptions | SellForFiatAmountOptions)
export interface SellResult { sellUrl: string }

export interface FiatQuote {
  cryptoAmount: bigint
  /** Smallest fiat unit (cents). */
  fiatAmount: bigint
  /** In the smallest fiat unit. */
  fee: bigint
  /** Standard units, as a string ("3000.50" = 1 ETH is 3000.50 USD). */
  rate: string
}

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

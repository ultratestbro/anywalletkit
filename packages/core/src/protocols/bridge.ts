// Base class: every method throws NotImplementedError so a module that forgets
// one fails loudly, never with `undefined is not a function`.
import type { IWalletAccount, IWalletAccountReadOnly } from '../account.js'
import { NotImplementedError } from '../errors.js'
import { ProtocolBase } from './base.js'

/** Fee ceiling for {@link IBridgeProtocol.bridge}. */
export interface BridgeProtocolConfig {
  /** Maximum fee for bridge operations, in native base units. */
  bridgeMaxFee?: bigint | number
}

/** Move `amount` of `token` (base units) to `recipient` on `targetChain`. */
export interface BridgeOptions {
  /** Destination chain identifier (provider specific, e.g. "arbitrum" or a CAIP-2 id). */
  targetChain: string
  recipient: string
  token: string
  amount: bigint | number
}

/** The bridge transaction and its fees. */
export interface BridgeResult {
  hash: string
  /** Gas cost. */
  fee: bigint
  /** Native tokens paid to the bridge protocol. */
  bridgeFee: bigint
}
/** Fees a bridge would pay; nothing is signed. */
export type BridgeQuote = Omit<BridgeResult, 'hash'>

/**
 * The older bridge-only interface. Every swap2 module implements it too; new code should use {@link
 * ISwap2Protocol}.
 */
export interface IBridgeProtocol {
  /** Sign and broadcast a bridge transfer. */
  bridge(options: BridgeOptions): Promise<BridgeResult>
  /** Fees of a bridge transfer; nothing is signed. */
  quoteBridge(options: BridgeOptions): Promise<BridgeQuote>
}

/** Base class for bridge-only modules. */
export class BridgeProtocol<TConfig extends BridgeProtocolConfig = BridgeProtocolConfig>
  extends ProtocolBase<TConfig>
  implements IBridgeProtocol
{
  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: TConfig = {} as TConfig) {
    super(account, config)
  }
  async bridge(_options: BridgeOptions): Promise<BridgeResult> { throw new NotImplementedError('bridge(options)') }
  async quoteBridge(_options: BridgeOptions): Promise<BridgeQuote> { throw new NotImplementedError('quoteBridge(options)') }
}

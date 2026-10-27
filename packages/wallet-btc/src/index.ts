export * from './types.js'
export { UnsafeTransactionError, TooManyInputsError, UnsupportedAddressTypeError, BroadcastUnknownError, type UnsafeTransactionCode } from './errors.js'
export { isAnsweredRefusal } from './http.js'
export { BlockbookClient, unconfirmedOutgoing, type BlockbookTxDetails, type BlockbookAddressPage, type BlockbookVin, type BlockbookVout } from './blockbook.js'
export { EsploraClient } from './esplora.js'
export { createClient } from './client.js'
export { signMessage, signMessageWith, encodeMessageSignature, magicHash, recoverMessagePublicKey, type SegwitType } from './message.js'
export { selectCoins, selectAll, estimateVsize, spendableUtxos, MAX_UTXO_INPUTS, type CoinSelection, type CoinSelectOptions, type SelectionTarget } from './coinselect.js'
export { describeTransaction, assertSafe, parseRawTransaction, DEFAULT_MAX_FEE_RATE, RBF_SEQUENCE, FINAL_SEQUENCE, type DescribeContext } from './describe.js'
export { addressFromPublicKey, addressFromScript, decodeAddress, scriptKind, dustLimit, outputVBytes, INPUT_WEIGHT, DUST_LIMIT_P2WPKH, DUST_LIMIT_P2TR, type ScriptKind, type DecodedAddress } from './address.js'
export { networkParams, REGTEST_NETWORK, coinType, purposeFor } from './network.js'
export { WalletAccountReadOnlyBtc, type SpendPlan } from './read-only-account.js'
export { WalletAccountBtc, addressFor } from './account.js'
export { WalletManagerBtc } from './manager.js'
export {
  createBtcHistory, mapBlockbookTx, btcExplorerTxUrl, HistoryUnavailableError,
  encodeCursor as encodeHistoryCursor, decodeCursor as decodeHistoryCursor,
  type BtcHistoryOptions, type BtcHistorySource, type BtcHistoryPage, type BtcChainTx, type BtcHistoryRaw, type BtcHistoryCursor,
} from './history.js'
export { WalletManagerBtc as default } from './manager.js'
export type { Built } from './account.js'
export type { BlockbookAddressTx } from './blockbook.js'

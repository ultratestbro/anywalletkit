import { WalletAccountReadOnlyNear, type NearRpc, type NearTransaction } from '@anywalletkit/wallet-near'
import { GAS_PRICE_MARGIN_DEN, GAS_PRICE_MARGIN_NUM, MIN_GAS_PURCHASE_PRICE_FALLBACK } from './constants.js'

// NEAR charges a transaction in two parts. When the node accepts it, the signer pays the conversion
// gas at the gas price and BUYS all prepaid gas upfront at max(gas price, min_gas_purchase_price)
// (protocol config; 10^9 on mainnet since protocol 88, ten times the 10^8 gas price). What the
// receipts do not burn comes back a few blocks later. So the balance a transaction needs is
// deposit + `upfront`, while what it finally costs is at most `fee`.

/** Gas prices behind {@link GasCost}, yoctoNEAR per gas. */
export interface GasPrices {
  /** The current gas price + 10 %: the margin wallet-near's own estimate uses. */
  gasPrice: bigint
  /** What the node charges per prepaid gas unit when it accepts a transaction. */
  purchasePrice: bigint
}

/** What a plan costs in NEAR, yoctoNEAR. */
export interface GasCost {
  /** Upper bound of the network fee: every gas unit burnt at {@link GasPrices.gasPrice}. Works as `maxFee`. */
  fee: bigint
  /** NEAR held back from the account when the node accepts the transactions (deposits excluded); the unburnt part is refunded. */
  upfront: bigint
}

/** How long the protocol config is reused: it changes only with a protocol upgrade. */
const PROTOCOL_CONFIG_TTL_MS = 10 * 60_000
/** How long a failed protocol-config read is answered by the fallback before it is tried again. */
const FALLBACK_TTL_MS = 60_000

/** Reads the gas price fresh and `min_gas_purchase_price` once per {@link PROTOCOL_CONFIG_TTL_MS}. */
export class GasPricer {
  private minPurchase: { at: number; ttl: number; value: Promise<bigint> } | undefined

  constructor(private readonly rpc: () => NearRpc) {}

  async prices(): Promise<GasPrices> {
    const [price, min] = await Promise.all([this.rpc().gasPrice(), this.minPurchasePrice()])
    const gasPrice = (price * GAS_PRICE_MARGIN_NUM) / GAS_PRICE_MARGIN_DEN
    return { gasPrice, purchasePrice: gasPrice > min ? gasPrice : min }
  }

  /** `runtime_config.min_gas_purchase_price`; the mainnet value when the node cannot say (fails toward a larger balance check). */
  private minPurchasePrice(): Promise<bigint> {
    const hit = this.minPurchase
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value
    const entry = { at: Date.now(), ttl: PROTOCOL_CONFIG_TTL_MS, value: Promise.resolve(MIN_GAS_PURCHASE_PRICE_FALLBACK) }
    entry.value = this.rpc().fetch('EXPERIMENTAL_protocol_config', { finality: 'final' }).then((r) => {
      const v = (r as { runtime_config?: { min_gas_purchase_price?: unknown } } | null)?.runtime_config?.min_gas_purchase_price
      if (typeof v === 'string' && /^\d{1,30}$/.test(v)) return BigInt(v)
      entry.ttl = FALLBACK_TTL_MS
      return MIN_GAS_PURCHASE_PRICE_FALLBACK
    }, () => {
      entry.ttl = FALLBACK_TTL_MS
      return MIN_GAS_PURCHASE_PRICE_FALLBACK
    })
    this.minPurchase = entry
    return entry.value
  }
}

/** Gas of the transactions as wallet-near counts it: conversion + prepaid, per action. */
export const gasOf = (txs: readonly NearTransaction[]): bigint =>
  txs.reduce((s, tx) => s + WalletAccountReadOnlyNear.gasOf(tx.actions, false), 0n)

/** Fee and upfront charge of `txs` at `prices`. */
export function costOf(txs: readonly NearTransaction[], prices: GasPrices): GasCost {
  const gas = gasOf(txs)
  return { fee: gas * prices.gasPrice, upfront: gas * prices.purchasePrice }
}

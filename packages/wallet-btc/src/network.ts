import { NETWORK, TEST_NETWORK } from '@scure/btc-signer'
import type { BTC_NETWORK } from '@scure/btc-signer/utils.js'
import type { BtcAddressType, BtcNetwork } from './types.js'

/** btc-signer ships mainnet + testnet; regtest only differs in the bech32 HRP. */
export const REGTEST_NETWORK: BTC_NETWORK = Object.freeze({ bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef })

export function networkParams(network: BtcNetwork): BTC_NETWORK {
  switch (network) {
    case 'bitcoin': return NETWORK
    case 'testnet': return TEST_NETWORK
    case 'regtest': return REGTEST_NETWORK
    default: throw new Error(`Unknown bitcoin network: ${String(network)}`)
  }
}

/** SLIP-44 coin type: 0 for mainnet, 1 for every test network. */
export const coinType = (network: BtcNetwork): 0 | 1 => (network === 'bitcoin' ? 0 : 1)

/** BIP purpose for the address type: 84 (p2wpkh) or 86 (p2tr). */
export const purposeFor = (type: BtcAddressType): 84 | 86 => (type === 'p2tr' ? 86 : 84)

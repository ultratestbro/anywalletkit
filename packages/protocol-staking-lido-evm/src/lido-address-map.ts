export interface LidoPermitDomain { name: string; version: string }

export interface LidoDeployment {
  stEth: string
  wstEth: string
  withdrawalQueue: string
  permitDomains: { stEth: LidoPermitDomain; wstEth: LidoPermitDomain }
  endpoints: { apr: string; withdrawalQueueApi: string; rewardHistory: string }
}

/**
 * Lido contract addresses and EIP-2612 permit domains, keyed by chain id.
 *
 * The permit domain versions are NOT guessable from the token names: they were
 * verified against each token's on-chain DOMAIN_SEPARATOR (stETH signs as
 * version "2", wstETH as version "1"). A wrong version produces a signature
 * that recovers to a different address — the permit call reverts with no
 * useful message, and the protocol silently falls back to the two-transaction
 * approve + request path.
 *
 * Only mainnet ships as a default: other deployments (e.g. the Hoodi testnet)
 * must be passed explicitly through the protocol's `config.addresses` /
 * `config.permitDomains` so that nobody stakes against an unverified address
 * that a default quietly supplied.
 */
const LIDO_ADDRESS_MAP: Record<number, LidoDeployment> = {
  1: {
    stEth: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84',
    wstEth: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0',
    withdrawalQueue: '0x889edc2edab5f40e902b864ad4d7ade8e412f9b1',
    permitDomains: {
      stEth: { name: 'Liquid staked Ether 2.0', version: '2' },
      wstEth: { name: 'Wrapped liquid staked Ether 2.0', version: '1' },
    },
    endpoints: {
      apr: 'https://eth-api.lido.fi/v1/protocol/steth/apr/sma',
      withdrawalQueueApi: 'https://wq-api.lido.fi',
      rewardHistory: 'https://reward-history-backend.lido.fi',
    },
  },
}

export default LIDO_ADDRESS_MAP

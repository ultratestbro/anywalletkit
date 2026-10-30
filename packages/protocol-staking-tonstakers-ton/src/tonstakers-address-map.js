'use strict'

/**
 * Tonstakers deployments, keyed by TON network id (-239 mainnet, -3 testnet).
 *
 * `pool` is the Tonstakers liquid-staking pool contract — stakes are messages
 * to it, and every on-chain read (`get_pool_full_data`) runs on it. `jetton`
 * is the tsTON jetton minter; unstakes are burns sent to the account's own
 * tsTON jetton wallet.
 * `partnerCode` is the referral attribution carried in the stake payload
 * (Tonstakers' partner program) — the official SDK's default ships here, a
 * partner overrides it through `config.partnerCode`.
 *
 * Mainnet verified live (2026-09-04): tonapi labels the pool `tonstake_pool`
 * (implementation liquidTF, verified), the minter reports symbol tsTON /
 * 9 decimals, and `get_pool_full_data`'s `jetton_minter` resolves to it.
 * Testnet: the pool address the SDK publishes, and the minter its
 * `get_pool_full_data` reports (verified live 2026-10-30).
 *
 * The account's jetton wallet is derived on the device from the minter's
 * pinned wallet code (`TONSTAKERS_JETTON_WALLET_CODES`) and must match the
 * minter's `get_wallet_address`.
 */
export default {
  '-239': {
    pool: 'EQCkWxfyhAkim3g2DjKQQg8T5P4g-Q1-K_jErGcDJZ4i-vqR',
    jetton: 'EQC98_qAmNEptUtPc7W6xdHh_ZHrBUFpw5Ft_IzNU20QAJav',
    partnerCode: 0x000000106796caefn,
    endpoints: {
      // Same sources the official SDK reads: tonapi for pool stats / APY
      // and the payout-bill index, Tonstakers' API for active payout rounds.
      tonapi: 'https://tonapi.io/v2',
      withdrawalPayouts: 'https://api.tonstakers.com/api/v1/pool/withdrawal_payout'
    }
  },
  '-3': {
    pool: 'kQANFsYyYn-GSZ4oajUJmboDURZU-udMHf9JxzO4vYM_hFP3',
    jetton: 'kQAiQ2XK7BXePLwemeo-u4wNyjg-wxGeySmaFGEP7R2Mhf4m',
    partnerCode: 0x000000106796caefn,
    endpoints: {
      tonapi: 'https://testnet.tonapi.io/v2',
      withdrawalPayouts: 'https://api.tonstakers.com/api/v1/pool/withdrawal_payout'
    }
  }
}

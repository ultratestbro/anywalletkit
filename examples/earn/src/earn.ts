// The "Earn" guide on docs.anywallet.tech renders the #region blocks of this file.

// #region setup
import { Wallet } from '@anywalletkit/kit'
import { WalletManagerEvm } from '@anywalletkit/wallet-evm'
import LidoProtocolEvm from '@anywalletkit/protocol-staking-lido-evm'
import { AaveProtocolEvm } from '@anywalletkit/protocol-lending-aave-evm'

export function walletWithEarn(seedPhrase: string): Wallet {
  const wallet = new Wallet(seedPhrase)
  wallet.registerWallet('eip155:1', WalletManagerEvm, { provider: 'https://ethereum-rpc.publicnode.com', chainId: 1 })
  // A protocol is bound to the account of one chain.
  wallet.registerProtocol('lido', LidoProtocolEvm, { chain: 'eip155:1' })
  wallet.registerProtocol('aave', AaveProtocolEvm, { chain: 'eip155:1', config: { market: 'core' } })
  return wallet
}
// #endregion setup

// #region stake
export async function stakeEth(wallet: Wallet, amount: bigint) {
  const lido = await wallet.getProtocol<LidoProtocolEvm>('lido')
  const { fee } = await lido.quoteStake({ amount }) // gas in wei, nothing is signed
  const { hash } = await lido.stake({ amount }) // ETH → stETH
  return { hash, fee }
}
// #endregion stake

// #region position
export async function stakingPosition(wallet: Wallet) {
  const lido = await wallet.getProtocol<LidoProtocolEvm>('lido')
  const position = await lido.getStakedBalance()
  return {
    staked: position.total, // the whole position in stETH, wei
    apr: await lido.getApr(), // percent: 2.7 = 2.7 %
  }
}
// #endregion position

// #region unstake
export async function unstake(wallet: Wallet, amount: bigint) {
  const lido = await wallet.getProtocol<LidoProtocolEvm>('lido')
  // Phase 1: join the withdrawal queue.
  await lido.requestWithdrawal({ amount })
}

export async function claimIfReady(wallet: Wallet) {
  const lido = await wallet.getProtocol<LidoProtocolEvm>('lido')
  const queue = await lido.getWithdrawalRequests()
  // queue.pendingAmount: still in the queue; queue.claimableAmount: ready to claim
  if (queue.claimableIds.length === 0) return null
  // Phase 2: claim the finalized requests back as ETH.
  return lido.claimWithdrawals({ ids: queue.claimableIds })
}
// #endregion unstake

// #region supply
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

export async function lendUsdc(wallet: Wallet, amount: bigint) {
  const aave = await wallet.getProtocol<AaveProtocolEvm>('aave')
  const apy = await aave.getSupplyApy(USDC) // 4.1 = 4.1 %
  const { fee } = await aave.quoteSupply({ token: USDC, amount })
  const result = await aave.supply({ token: USDC, amount }) // permit when the token supports it, else an exact approval
  return { apy, fee, hash: result.hash }
}

export async function withdrawAll(wallet: Wallet) {
  const aave = await wallet.getProtocol<AaveProtocolEvm>('aave')
  return aave.withdraw({ token: USDC, amount: 'max' }) // principal + interest
}
// #endregion supply

// #region lending-position
export async function lendingPosition(wallet: Wallet) {
  const aave = await wallet.getProtocol<AaveProtocolEvm>('aave')
  const { supplies, borrows, account } = await aave.getPosition()
  return {
    supplies, // [{ token, symbol, amount, supplyApy, collateral }]
    borrows, // [{ token, symbol, amount, borrowApy }]
    healthFactor: account.healthFactor, // < 1 = liquidation; Infinity without debt
  }
}
// #endregion lending-position

// Not rendered in the guide. Modules also construct directly over a wallet-evm account,
// signing or read-only (apps on the keyring do this); a typed caller must compile.
import type { WalletAccountEvm, WalletAccountReadOnlyEvm } from '@anywalletkit/wallet-evm'
export const lidoOver = (account: WalletAccountEvm | WalletAccountReadOnlyEvm) => new LidoProtocolEvm(account)
export const aaveOver = (account: WalletAccountEvm | WalletAccountReadOnlyEvm) => new AaveProtocolEvm(account, { market: 'core' })

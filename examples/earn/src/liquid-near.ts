// The "Liquid NEAR staking (LiNEAR, rNEAR)" part of the Earn guide renders the #region blocks of this file.

// #region liquid-setup
import { Wallet } from '@anywalletkit/kit'
import { WalletManagerNear, type NearTransaction } from '@anywalletkit/wallet-near'
import { LiquidStakingProtocolNear } from '@anywalletkit/protocol-staking-liquid-near'

export function walletWithLiquidNear(seedPhrase: string, rpc = 'https://free.rpc.fastnear.com'): Wallet {
  const wallet = new Wallet(seedPhrase)
  wallet.registerWallet('near', WalletManagerNear, { provider: rpc })
  // One module per contract, each pinned by account id and code hash.
  wallet.registerProtocol('linear', LiquidStakingProtocolNear, { chain: 'near:mainnet', config: { pool: 'linear' } }) // LiNEAR: linear-protocol.near
  wallet.registerProtocol('rnear', LiquidStakingProtocolNear, { chain: 'near:mainnet', config: { pool: 'rnear' } }) // Rhea rNEAR: lst.rhealab.near
  return wallet
}
// #endregion liquid-setup

// #region liquid-stake
export async function quoteLinearStake(wallet: Wallet, yocto: bigint) {
  const linear = await wallet.getProtocol<LiquidStakingProtocolNear>('linear')
  // Reads the contract fresh (live code hash against the pin, pause flag) and plans the exact transaction; nothing is signed.
  const quote = await linear.quoteStake({ amount: yocto })
  // quote.transactions: one deposit_and_stake (it registers the account itself); quote.shares: LINEAR minted at today's price
  return quote
}

export async function stakeLinear(wallet: Wallet, yocto: bigint, confirmed: NearTransaction[]) {
  const linear = await wallet.getProtocol<LiquidStakingProtocolNear>('linear')
  const { hash, shares } = await linear.stake({ amount: yocto, expected: confirmed }) // 'quote-changed' when the fresh plan differs
  return { hash, shares }
}
// #endregion liquid-stake

// #region liquid-position
export async function linearPosition(wallet: Wallet) {
  const linear = await wallet.getProtocol<LiquidStakingProtocolNear>('linear')
  const { balance, total, price, unstaked, withdrawable } = await linear.getStakedBalance() // LINEAR held; their NEAR value at `price`
  return { balance, total, price, unstaked, withdrawable, apr: await linear.getApr() } // APR from the price over ~7 days
}
// #endregion liquid-position

// #region liquid-unstake
export async function unstakeLinear(wallet: Wallet, shares: bigint | 'all') {
  const linear = await wallet.getProtocol<LiquidStakingProtocolNear>('linear')
  // Token units in; the contract's unstake takes their NEAR value ('all' = unstake_all).
  const quote = await linear.quoteRequestWithdrawal({ amount: shares })
  const { hash, unlock } = await linear.requestWithdrawal({ amount: shares, expected: quote.transactions })
  // Show unlock.earliestEpoch / earliestAt (current + 4; the contract may add epochs). The exact epoch is not readable yet:
  // the send returns before the unstake is final, and reads use final blocks, so they still show the previous unlock epoch.
  return { hash, unlock }
}

export async function linearUnlockEpoch(wallet: Wallet, earliestEpoch: bigint) {
  const linear = await wallet.getProtocol<LiquidStakingProtocolNear>('linear')
  const { requests } = await linear.getWithdrawalRequests() // one request per contract at most
  const request = requests[0]
  // Below the quote's earliest epoch, the read predates the final unstake (0 on a first one): read again a few seconds later.
  if (!request || request.unlockEpoch < earliestEpoch) return null
  return { unlockEpoch: request.unlockEpoch, unlock: request.unlock } // exact, from the contract; unlock.at is its date
}

export async function claimLinear(wallet: Wallet) {
  const linear = await wallet.getProtocol<LiquidStakingProtocolNear>('linear')
  const { requests, claimableIds } = await linear.getWithdrawalRequests() // one request per contract at most
  // Unlocked but `awaitingLiquidity`: the contract is waiting for its payout from the validators.
  if (claimableIds.length === 0) return { hash: null, awaitingLiquidity: requests[0]?.awaitingLiquidity ?? false }
  const { hash } = await linear.claimWithdrawals({ ids: claimableIds }) // withdraw_all
  return { hash, awaitingLiquidity: false }
}
// #endregion liquid-unstake

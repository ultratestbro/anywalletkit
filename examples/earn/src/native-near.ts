// The "Native NEAR staking" part of the Earn guide renders the #region blocks of this file.

// #region near-setup
import { Wallet } from '@anywalletkit/kit'
import { WalletManagerNear, type NearTransaction } from '@anywalletkit/wallet-near'
import { NativeStakingProtocolNear } from '@anywalletkit/protocol-staking-native-near'

export function walletWithNearStaking(seedPhrase: string, rpc = 'https://free.rpc.fastnear.com'): Wallet {
  const wallet = new Wallet(seedPhrase)
  wallet.registerWallet('near', WalletManagerNear, { provider: rpc })
  wallet.registerProtocol('near-staking', NativeStakingProtocolNear, {
    chain: 'near:mainnet',
    config: {
      // Required: the staking pools your wallet offers. Replace them with your own choice.
      pools: [{ id: 'astro-stakers.poolv1.near', name: 'Pool A' }, { id: 'figment.poolv1.near', name: 'Pool B' }],
      defaultPool: 'astro-stakers.poolv1.near',
      maxFee: 10, // refuse a pool whose reward fee is above 10 % (read fresh at every stake)
    },
  })
  return wallet
}
// #endregion near-setup

// #region near-stake
export async function quoteNearStake(wallet: Wallet, yocto: bigint) {
  const staking = await wallet.getProtocol<NativeStakingProtocolNear>('near-staking')
  // Reads the pool live (code hash, pause, fee, validator sets) and plans the exact transaction; nothing is signed.
  const quote = await staking.quoteStake({ amount: yocto })
  // quote.transactions: [{ receiverId: pool, actions: [deposit_and_stake] }]; quote.fee: the most it costs;
  // quote.upfront: prepaid gas the node holds back until the unburnt part is refunded; quote.reserve stays on the account.
  return quote
}

export async function stakeNear(wallet: Wallet, yocto: bigint, confirmed: NearTransaction[]) {
  const staking = await wallet.getProtocol<NativeStakingProtocolNear>('near-staking')
  // Plans again with fresh reads and refuses with 'quote-changed' when that differs from what the user confirmed.
  const { hash, pool } = await staking.stake({ amount: yocto, expected: confirmed })
  return { hash, pool: pool.id }
}
// #endregion near-stake

// #region near-position
export async function nearPosition(wallet: Wallet) {
  const staking = await wallet.getProtocol<NativeStakingProtocolNear>('near-staking')
  const pools = await staking.getPools(['astro-stakers.poolv1.near', 'figment.poolv1.near']) // fee, paused, apr; `eligible` and `refusals`
  const { balance, total, positions } = await staking.getStakedBalance() // staked; staked + unstaked; one entry per pool
  return { pools, balance, total, positions, apr: await staking.getApr() } // the default pool's APR after its fee
}
// #endregion near-position

// #region near-unstake
export async function unstakeNear(wallet: Wallet, yocto: bigint | 'all') {
  const staking = await wallet.getProtocol<NativeStakingProtocolNear>('near-staking')
  // unstake / unstake_all; [withdraw_all, unstake] when NEAR already unlocked waits in the pool, so it is not locked again.
  const quote = await staking.quoteRequestWithdrawal({ amount: yocto })
  const { hash, unlock } = await staking.requestWithdrawal({ amount: yocto, expected: quote.transactions })
  return { hash, unlock } // 4 epochs: unlock.earliestAt … unlock.latestAt, about 21–28 h (null when the epoch could not be read)
}

export async function claimNear(wallet: Wallet) {
  const staking = await wallet.getProtocol<NativeStakingProtocolNear>('near-staking')
  const { claimableIds } = await staking.getWithdrawalRequests() // one request per pool that holds unstaked NEAR
  if (claimableIds.length === 0) return null
  return staking.claimWithdrawals({ ids: claimableIds }) // withdraw_all per pool
}
// #endregion near-unstake

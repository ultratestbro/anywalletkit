// The "Native MON staking" part of the Earn guide renders the #region blocks of this file.

// #region monad-setup
import { Wallet } from '@anywalletkit/kit'
import { WalletManagerEvm } from '@anywalletkit/wallet-evm'
import { NativeStakingProtocolMonad } from '@anywalletkit/protocol-staking-native-monad'

export function walletWithMonadStaking(seedPhrase: string, rpc = 'https://rpc.monad.xyz'): Wallet {
  const wallet = new Wallet(seedPhrase)
  wallet.registerWallet('eip155:143', WalletManagerEvm, { provider: rpc, chainId: 143 })
  wallet.registerProtocol('mon-staking', NativeStakingProtocolMonad, {
    chain: 'eip155:143',
    config: {
      // Required: the validator ids your wallet delegates to. Replace them with your own choice.
      validators: [{ id: 97n, name: 'Validator A' }, { id: 21n, name: 'Validator B' }],
      defaultValidator: 97n,
      maxCommission: 10, // refuse a validator whose commission is above 10 % (checked at every delegation)
    },
  })
  return wallet
}
// #endregion monad-setup

// #region monad-stake
export async function stakeMon(wallet: Wallet, wei: bigint) {
  const staking = await wallet.getProtocol<NativeStakingProtocolMonad>('mon-staking')
  const validators = await staking.listValidators() // live commission, standing, APR; `eligible` and `refusals`
  const quote = await staking.quoteStake({ amount: wei }) // simulated, nothing is signed; keeps the 10 MON reserve
  const result = await staking.stake({ amount: wei }) // delegate(97) with the amount as value
  return { validators, fee: quote.fee, hash: result.hash, activeFrom: result.activatesAtEpoch } // epoch n+1, or n+2 after the boundary block
}

export async function monadPosition(wallet: Wallet) {
  const staking = await wallet.getProtocol<NativeStakingProtocolMonad>('mon-staking')
  const positions = await staking.listPositions() // per validator: active, activating, unclaimed rewards
  const { balance, total, unclaimedRewards } = await staking.getStakedBalance()
  return { positions, balance, total, unclaimedRewards, apr: await staking.getApr() }
}
// #endregion monad-stake

// #region monad-unstake
export async function unstakeMon(wallet: Wallet, wei: bigint) {
  const staking = await wallet.getProtocol<NativeStakingProtocolMonad>('mon-staking')
  // Only active stake can be undelegated; the module picks a free withdrawal slot (0..255).
  const { id, withdrawableAtEpoch } = await staking.requestWithdrawal({ amount: wei, validator: 97n })
  return { id, withdrawableAtEpoch } // claimable one epoch after the stake deactivates
}

export async function claimMon(wallet: Wallet) {
  const staking = await wallet.getProtocol<NativeStakingProtocolMonad>('mon-staking')
  const { claimableIds } = await staking.getWithdrawalRequests({ validator: 97n })
  if (claimableIds.length > 0) await staking.claimWithdrawals({ ids: claimableIds }) // one withdraw per request
  const position = (await staking.listPositions()).find((p) => p.validatorId === 97n)
  if (position && position.unclaimedRewards > 0n) await staking.claimRewards({ validator: 97n }) // or compound({ validator })
  return { claimed: claimableIds.length }
}
// #endregion monad-unstake

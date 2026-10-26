// The "Native SOL staking" part of the Earn guide renders the #region blocks of this file.

// #region native-setup
import { Wallet } from '@anywalletkit/kit'
import { WalletManagerSolana } from '@anywalletkit/wallet-solana'
import { NativeStakingProtocolSolana } from '@anywalletkit/protocol-staking-native-solana'

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'

export function walletWithNativeStaking(seedPhrase: string, rpc = 'https://api.mainnet-beta.solana.com'): Wallet {
  const wallet = new Wallet(seedPhrase)
  wallet.registerWallet('solana', WalletManagerSolana, { provider: rpc })
  wallet.registerProtocol('sol-staking', NativeStakingProtocolSolana, {
    chain: SOLANA,
    config: {
      // Required: the vote accounts your wallet delegates to. Replace these with your own choice.
      validators: [
        { voteAccount: 'he1iusunGwqrNtafDtLdhsUQDFvo13z9sUa36PauBtk', name: 'Validator A' },
        { voteAccount: 'CatzoSMUkTRidT5DwBxAC2pEtnwMBTpkCepHkFgZDiqb', name: 'Validator B' },
      ],
      maxCommission: 10, // refuse a validator whose commission is above 10 % (checked at every delegation)
    },
  })
  return wallet
}
// #endregion native-setup

// #region native-stake
export async function stakeSol(wallet: Wallet, lamports: bigint) {
  const staking = await wallet.getProtocol<NativeStakingProtocolSolana>('sol-staking')
  const validators = await staking.listValidators() // live commission, stake, APR; `eligible` and `refusals`
  const pick = validators.find((v) => v.eligible)!
  const quote = await staking.quoteStake({ amount: lamports, validator: pick.voteAccount }) // ≥ 1 SOL; nothing is signed
  // quote.total = amount + the stake account's rent (returned on withdraw); quote.fee = network fee
  const result = await staking.stake({ amount: lamports, validator: pick.voteAccount })
  return { hash: result.hash, stakeAccount: result.stakeAccount, activeFrom: result.readyEpoch }
}
// #endregion native-stake

// #region native-position
export async function nativePosition(wallet: Wallet) {
  const staking = await wallet.getProtocol<NativeStakingProtocolSolana>('sol-staking')
  const accounts = await staking.getStakeAccounts() // one per delegation: status, validator, amounts, readyAt
  const { balance, total } = await staking.getStakedBalance() // delegated lamports; everything in stake accounts
  return { accounts, balance, total, apr: await staking.getApr() }
}
// #endregion native-position

// #region native-unstake
export async function unstakeSol(wallet: Wallet, lamports: bigint) {
  const staking = await wallet.getProtocol<NativeStakingProtocolSolana>('sol-staking')
  // Whole accounts are deactivated; a partial amount is split into a new account first.
  const { steps, readyAt } = await staking.requestWithdrawal({ amount: lamports })
  return { steps, readyAt } // the SOL can be claimed after the epoch boundary (~2 days)
}

export async function claimSol(wallet: Wallet) {
  const staking = await wallet.getProtocol<NativeStakingProtocolSolana>('sol-staking')
  const { claimableIds } = await staking.getWithdrawalRequests()
  if (claimableIds.length === 0) return null
  return staking.claimWithdrawals({ ids: claimableIds }) // every lamport, rent included, back to the wallet
}
// #endregion native-unstake

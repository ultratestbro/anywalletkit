# @anywalletkit/protocol-staking-native-solana

Native SOL staking for `@anywalletkit/wallet-solana` accounts: SOL delegated straight to the
validators **your app lists**, through Solana's Stake program. No pool, no token, no third-party
program. Each position is a stake account owned by the wallet.

```sh
npm install @anywalletkit/protocol-staking-native-solana @anywalletkit/wallet-solana
```

## Usage

```ts
import { Wallet } from '@anywalletkit/kit'
import { WalletManagerSolana } from '@anywalletkit/wallet-solana'
import { NativeStakingProtocolSolana } from '@anywalletkit/protocol-staking-native-solana'

const wallet = new Wallet(seedPhrase)
wallet.registerWallet('solana', WalletManagerSolana, { provider: SOLANA_RPC })
wallet.registerProtocol('sol-staking', NativeStakingProtocolSolana, {
  chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  config: {
    validators: [{ voteAccount: VOTE_A, name: 'Our validator' }, VOTE_B], // required
    maxCommission: 10,
  },
})
const staking = await wallet.getProtocol<NativeStakingProtocolSolana>('sol-staking')

const validators = await staking.listValidators()          // commission, delinquent, apr, eligible, refusals
await staking.quoteStake({ amount: 2_000_000_000n })       // fee, stake account, rent, readyEpoch; nothing signed
await staking.stake({ amount: 2_000_000_000n, validator: VOTE_A })

await staking.getStakeAccounts()                           // per account: status, amounts, validator, readyAt
await staking.getStakedBalance()                           // { balance, total, active, activating, deactivating, claimable }
await staking.requestWithdrawal({ amount: 1_000_000_000n }) // deactivate (split first when partial)
const q = await staking.getWithdrawalRequests()
if (q.claimableIds.length) await staking.claimWithdrawals({ ids: q.claimableIds })
```

Amounts are lamports (bigint). Without `provider` in the config, reads go to the account's own RPC.

## Config

| Option | Default | |
|---|---|---|
| `validators` | — (required) | Vote accounts (strings or `{ voteAccount, name }`), or `'any'` to let users pick from the whole cluster. No list, no module. |
| `defaultValidator` | first eligible of the list | Used when `stake` / `delegate` name none. Must be in the list. No default in `'any'` mode. |
| `maxCommission` | `10` | Percent. A validator above it is refused at delegation time (commission can change after you list it). |
| `allowDelinquent` | `false` | Delinquent validators earn their stake nothing. |
| `provider` | the account's RPC | URL, list of URLs (failover), `@solana/rpc` client or `{ request(method, params) }`. |
| `discover` | `false` | Also list stake accounts other wallets created for the address (`getProgramAccounts`; the RPC must serve it). Only those the wallet is the withdraw authority of (`owned`) count in the position and can be unstaked, delegated or merged. |
| `seedPrefix` / `maxAccounts` | `stake:` / `32` | Stake accounts live at `create_with_seed(wallet, "<prefix><i>", Stake)`, `i < maxAccounts`. |
| `feeReserve` | 0.005 SOL | Kept on the wallet by `stake`, so the user can still pay to unstake and claim. |
| `computeUnitLimit` / `computeUnitPrice` | wallet decides | Explicit compute budget; otherwise the wallet sets it from simulation and recent fees. |
| `enrich` | — | `(voteAccounts) => ({ [vote]: { apr, name, … } })`: an explorer's APR (with MEV), names, scores. Decoration only. |
| `commitment` / `timeoutMs` / `fetch` | `confirmed` / 15 s / global | Reads. |

## How it works

- **Stake** is one transaction: System `CreateAccountWithSeed` (amount + rent, base = the wallet),
  Stake `Initialize` (staker = withdrawer = the wallet, no lockup), `DelegateStake`. Only the wallet
  signs. It becomes active at the next epoch boundary (~2 days). The minimum is the Stake program's
  minimum delegation (1 SOL) plus about 0.0017 SOL of rent, which returns on withdrawal.
- **Statuses** come from the StakeHistory sysvar with the program's own integer warm-up / cool-down
  math (9 % of the cluster per epoch), so `inactive` means the program will let every lamport out.
  Each account reports `effective`, `activating`, `deactivating`, `withdrawable`, and while it
  changes, `readyEpoch` / `readyAt`.
- **Unstake** deactivates whole accounts and splits at most one: an exact match first, else the plan
  with the fewest steps where the split part and what stays behind both keep the minimum delegation.
  The split part goes to a new seed account (prefunded with rent) and is deactivated. A stake
  deactivated in the epoch it was made is free at once.
- **Claim** withdraws fully inactive accounts to the wallet (the accounts close), up to 10 per
  transaction: with more ids or more ready accounts, `remaining` says how many are left for the next call.
- **Delegate** re-delegates an inactive account, or, in the epoch an account was deactivated, puts
  it back on its validator (undoes the unstake; the validator must still pass the policy). An account
  still activating moves only to a validator named in the call. **Merge** joins two inactive accounts, two fully
  active ones on the same validator, or two activated this epoch on the same validator.
- **APR**: `getApr()` / `ValidatorInfo.apr` is validator inflation × supply ÷ staked SOL ×
  (1 − commission). It leaves out MEV and block-reward sharing; pass `enrich` for a fuller figure.
  `getRewards({ epochs })` lists the inflation rewards the wallet's accounts actually received.

## Safety

- Fail-closed before anything is signed: unlisted, unknown, delinquent or over-commission
  validators; amounts under the minimum; a wallet that would drop under `feeReserve`; accounts the
  wallet is not the authority of; a lockup in force; merges the program would reject.
- Accounts the module creates have the wallet as staker and withdrawer and no lockup. It never sets
  a custodian, never changes an authority, and never acts on an account whose SOL another address
  withdraws (a `discover`ed account the wallet only manages).
- Seed slots: someone can send dust to a `stake:<i>` address before the wallet uses it. Empty slots
  are used first. When only pre-funded ones are left, taking one over needs Transfer +
  AllocateWithSeed, which `wallet-solana` refuses to sign by default (`allowAuthorityChanges`); the
  module then says so, and `maxAccounts` (up to 100) opens new slots. Every write the module builds
  is tested against `wallet-solana`'s signing checks with the default config.
- StakeHistory from an RPC node that has not reached the current epoch is refused, so statuses are
  never computed from a stale sysvar.
- With a Solana `allowlist` policy, staking writes go to the Stake program and to new stake
  accounts: allow `Stake11111111111111111111111111111111111111` and the addresses from
  `getStakeAccountAddress(i)`.

## Testing

- `pnpm test`: codecs byte for byte against mainnet transactions, the activation math against
  hand-computed program cases, every operation over an in-memory node, conformance with recorded
  mainnet activity.
- `pnpm verify:live [address] [rpcUrl]`: reads on mainnet, then every write planned for a real wallet
  and simulated by the wallet (`simulateTransaction`, signatures off). Nothing is signed.

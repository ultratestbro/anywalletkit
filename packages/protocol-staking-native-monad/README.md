# @anywalletkit/protocol-staking-native-monad

Native MON staking for `@anywalletkit/wallet-evm` accounts on Monad (chain 143, testnet 10143):
delegations straight to the validators **your app lists**, through Monad's staking precompile at
`0x0000000000000000000000000000000000001000`. No pool, no token, no extra contract.

```sh
npm install @anywalletkit/protocol-staking-native-monad @anywalletkit/wallet-evm
```

## Usage

```ts
import { Wallet } from '@anywalletkit/kit'
import { WalletManagerEvm } from '@anywalletkit/wallet-evm'
import { NativeStakingProtocolMonad } from '@anywalletkit/protocol-staking-native-monad'

const wallet = new Wallet(seedPhrase)
wallet.registerWallet('eip155:143', WalletManagerEvm, { provider: ['https://rpc.monad.xyz'], chainId: 143 })
const account = await wallet.getAccount('eip155:143')

// Your own validator(s):
const staking = new NativeStakingProtocolMonad(account, { validators: [{ id: 12n, name: 'Our validator' }] })
await staking.stake({ amount: 10n ** 18n })                    // delegate(12), 1 MON
await staking.requestWithdrawal({ amount: 10n ** 18n })        // undelegate into a free slot
// … one epoch after the stake deactivates …
await staking.claimWithdrawals()                                // withdraw every ready request

// Or let users pick from the active set:
const open = new NativeStakingProtocolMonad(account, { validators: 'any' })
const validators = await open.listValidators()                  // by stake: commission, active, apr, eligible, refusals
await open.stake({ amount: 10n ** 18n, validator: validators[0].id })
```

Amounts are wei (bigint). Without `provider` in the config, reads go to the account's own RPC.

## Config

| Option | Default | |
|---|---|---|
| `validators` | — (required) | Validator ids (bigint / number / `{ id, name }`), or `'any'`. No list, no module. |
| `defaultValidator` | the only listed id | Used when a call names no validator; with several listed and no default, calls must name one. |
| `maxCommission` | `10` | Percent. Checked against a fresh read of the validator (current and upcoming commission, compared in the precompile's 1e18 scale) at every delegation and compound. |
| `allowInactive` | `false` | Delegate to validators outside the consensus set or flagged by the precompile (their stake earns nothing). |
| `chainId` | the account's | Pin 143 or 10143. The account and the read RPC must both be on it. Pin it when you list validator ids: ids differ between mainnet and testnet. |
| `provider` | the account's RPC | URL, list (failover) or EIP-1193 provider, for reads and simulation. |
| `reserveBalance` | 10 MON | Left on the wallet by `stake`; at least 10 MON, Monad's reserve balance (value transfers that dip below it revert). |
| `maxWithdrawId` | `255` | Highest withdrawal slot used and scanned. |
| `withdrawScan` | `'gap'` | `'gap'` reads withdrawal slots from 0 and stops 32 empty slots past the last used one; `'full'` reads all 256 per validator. |
| `concurrency` | `6` | Reads in flight (public Monad RPCs cap requests per second; batching counts each call). |
| `enrich` | — | `(ids) => ({ [id]: { apr, name, … } })`: an explorer's APR, names, logos. Decoration only. |
| `stakingAddress` / `timeoutMs` | `0x…1000` / 15 s | |

## Methods

| Shared `StakingProtocol` | What it does on Monad |
|---|---|
| `stake({ amount, validator? })` | `delegate(validatorId)` with the amount as value |
| `requestWithdrawal({ amount, validator?, withdrawId? })` | `undelegate(validatorId, amount, withdrawId)`; the lowest free slot by default |
| `getWithdrawalRequests({ validator?, validators? })` | pending withdrawals; `id` = `validatorId << 8 \| withdrawId` |
| `claimWithdrawals({ ids?, validators? })` | `withdraw(validatorId, withdrawId)` per ready request (one transaction each) |
| `getStakedBalance()` | `balance` = active stake, `total` = active + activating; `unclaimedRewards` apart |
| `getApr({ validator? })` | `enrich`'s APR, or the estimate below |

Monad extras: `compound` / `claimRewards` (+ quotes), `getEpoch()` → `{ epoch, inEpochDelayPeriod,
activatesAtEpoch }`, `listValidators`, `getValidator`, `listPositions`, `nextWithdrawId`,
`getNetworkStats`, `getMaxStakeable`. Every write has a `quote*` twin that signs nothing.

## Timing

- A stake (or a compound) becomes active in epoch n+1, or n+2 when sent after the epoch's boundary
  block (`getEpoch().inEpochDelayPeriod`). Epochs are about 4 hours; they are counted in rounds, not
  blocks, so the module always asks `getEpoch()`.
- Only active stake can be undelegated. Stake that is still activating shows in `activating` /
  `activatingNext` with its epoch.
- An undelegated amount deactivates at n+1 (or n+2) and can be withdrawn one epoch later
  (`withdrawableAtEpoch`). Rewards keep accruing until then and are paid with the withdrawal.
- `claimRewards` pays at once; `compound` follows the stake timing.

## APR

`apr` is 18 MON per block × blocks per year ÷ the consensus set's stake × (1 − commission). The block
time is measured over the last 50 000 blocks; the stake is summed over the consensus set (one read
per validator, cached). It assumes the validator proposes its share of blocks; pass `enrich` for a
measured figure.

## Safety

- Fail-closed before anything is signed: unlisted, unknown, inactive or over-commission validators;
  amounts under 1 gwei or above the active stake; a stake that would leave less than the reserve;
  withdrawal slots in use or all 256 taken; requests not yet open; an account or read RPC that is not
  on Monad (or on the pinned chain).
- Every write is simulated with `eth_call` as the wallet first, and the precompile's revert comes back
  in plain words (`withdrawal not ready`, `insufficient stake`, `reserve balance violation`, …).
- The module never uses multicall, STATICCALL or EIP-7702 against the precompile (all revert there).
- Policies: the transactions go to `0x0000000000000000000000000000000000001000`; an `allowlist` must
  include it.
- **Full exits.** Once the wallet's stake with a validator reaches zero, the precompile drops that
  validator from `getDelegations`, while the withdrawal is still pending. The module still looks at the
  listed validators and those this instance undelegated from; in `'any'` mode keep the `id` that
  `requestWithdrawal` returns (`claimWithdrawals({ ids })` always works) or pass the validator in
  `validators` (the activity feed has it).
- Reading withdrawals costs one `eth_call` per slot: the gap scan reads about 36 slots for a validator
  without withdrawals; `withdrawScan: 'full'` reads all 256. Pass `validator` to read one position.
- Validator data for display is cached for a minute; every write decision reads the validator again.

## Testing

- `pnpm test`: selectors and topics against Monad's published values, id packing, timing rules,
  every operation and refusal over an in-memory precompile, conformance with recorded mainnet
  transactions (delegate, undelegate, withdraw, compound, claimRewards).
- `pnpm verify:live [rpcUrl] [chainId]`: mainnet reads, then every write planned for real delegators
  found from recent events and simulated by the module and by the wallet. Nothing is signed. There is
  no forked testing: the precompile has no code to fork.

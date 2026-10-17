# @forgewallet/protocol-staking-spl-stake-pool-solana

A simple package that lets `@forgewallet/wallet-solana` wallet accounts stake
through pools on the [SPL Stake Pool](https://github.com/solana-program/stake-pool)
program — [Jito](https://www.jito.network) by default: stake SOL → JitoSOL,
exit instantly from the reserve or through a stake account, claim, read
rates, APY and earnings.

Built as the **fourth implementation of the proposed `StakingProtocol` type**
for `@forgewallet/core` — after
Lido (ETH
liquid staking),
SSV (token
staking with a cooldown) and
Tonstakers
(GRAM liquid staking) — and the second one off EVM. The base class in
`src/staking-protocol.js` is the same file, byte-identical: the type is
chain-agnostic, and Solana's two-shape exit (instant vs. stake account +
epoch boundary) fits its request → queue → claim contract.

The mechanics are extracted from a production wallet (React Native/Hermes).
Verification status (2026-09-07, mainnet): **stake and instant exit ran with
real funds** from the wallet (four transactions, amounts matched the module's
quotes to the lamport); the **delayed exit** (stake account + deactivate) is
verified by `simulateTransaction` as a large holder, and the **claim** only by
its instruction layout — a funded delayed → claim cycle needs a position of
≥ 1 SOL worth and is still to be run. `scripts/verify-live.mjs` re-checks
every shape the account can afford, keys never involved.

## What an SPL stake pool and JitoSOL are

An SPL stake pool holds stake accounts on many validators plus a reserve. The
**pool token** (JitoSOL for Jito; bSOL and most validator LSTs use the same
program) is the non-rebasing receipt whose SOL value is
`total_lamports / pool_token_supply`, moved once per epoch (~2 days) when the
pool's crank applies the epoch's rewards. Jito adds MEV tips on top of
inflation rewards.

- **Stake** is one `DepositSol` instruction: SOL goes to the reserve, tokens
  are minted at the rate (Jito: no deposit fee).
- **Instant exit** — `WithdrawSol`: burn tokens, SOL is paid from the reserve
  at once, minus the pool's SOL withdrawal fee (Jito: 0.1 %). Only while the
  reserve holds enough (typically ~1 000 SOL).
- **Delayed exit** — `WithdrawStake`: burn tokens, the pool splits a validator
  stake account to a fresh stake account owned by the wallet (Jito: 0.1 %
  fee); this module deactivates it in the same transaction. After the epoch
  boundary the account is inactive and **claim** sweeps the SOL (and the
  account's rent) back to the wallet. The stake program's minimum delegation
  (1 SOL + rent) is the floor for this path.

The wallet's stake accounts are derived with seeds
(`createWithSeed(wallet, "<pool>-unstake:<i>", StakeProgram)`, 8 slots), so
the queue is recoverable from the wallet alone and no ephemeral keypair ever
signs.

## Usage

```js
import WalletManagerSolana from '@forgewallet/wallet-solana'
import SplStakePoolProtocolSolana from '@forgewallet/protocol-staking-spl-stake-pool-solana'

const wallet = new WalletManagerSolana(seed, { provider: 'https://api.mainnet-beta.solana.com' })
const account = await wallet.getAccount(0)

const jito = new SplStakePoolProtocolSolana(account) // pool: 'jito' by default; reads ride the account's RPC

// Stake 1 SOL — JitoSOL lands at the pool rate (DepositSolWithSlippage, 0.5 % floor)
const { hash, fee } = await jito.stake({ amount: 10n ** 9n })
await jito.awaitConfirmation(hash)

// Exit: delayed (default — stake account, claim after the epoch boundary) or instant (reserve)
await jito.requestWithdrawal({ amount: 10n ** 9n })                    // ≥ 1 SOL worth
await jito.requestWithdrawal({ amount: 5n * 10n ** 7n, mode: 'instant' })

// The queue, then the claim
const { requests, claimableIds } = await jito.getWithdrawalRequests()
if (claimableIds.length) await jito.claimWithdrawals({ ids: claimableIds })

// Views
await jito.getStakedBalance()   // { balance: JitoSOL, rate: lamports per JitoSOL (1e9), total: lamports }
await jito.getPoolData()        // rate, previousRate, updated, instantLiquidity, fees, minimumStakeLamports…
await jito.getApr()             // percent — on-chain estimate, or your provider's figure via the `apr` hook
await jito.getRewards()         // { earned, entryRate, deposited, minted, firstStakeAt } from the account's own deposits
```

### Configuration

```js
new SplStakePoolProtocolSolana(account, {
  pool: 'jito',                        // or { name, pool, mint, symbol } for any pool on the program
  provider: [url1, url2],              // JSON-RPC URL(s), a @solana/rpc client, or { request(method, params) }
  commitment: 'confirmed',
  slippageBps: 50,                     // floor on quoted amounts (..WithSlippage instructions)
  computeUnitLimit: 300_000,
  computeUnitPrice: 50_000n,           // micro-lamports per unit — ≈ 0.000015 SOL priority fee
  unstakeSlots: 8,                     // delayed exits tracked per wallet
  apr: async () => fetchJitoApy()      // provider APY hook (Jito's stats include MEV); default: epoch-over-epoch estimate
})
```

A read-only account (`{ getAddress }`) is enough for every view; writes need
an account with `sendTransaction`. The module hands the account a bare
`{ version: 0, instructions }` message — `@forgewallet/wallet-solana` sets
the blockhash lifetime and the fee-payer signer, signs and broadcasts; the
key never enters the module.

## Fail-closed rules

Checked before any transaction is built:

- the configured mint must equal the on-chain pool's mint; the pool account
  must be owned by the SPL Stake Pool program;
- the pool must be updated for the current epoch (`last_update_epoch ==
  epoch`) — the program rejects every deposit and withdrawal otherwise;
- a delayed exit must yield at least `rent + minimum delegation` and leave
  the split-from validator account the same minimum (checked against the
  live balance, not only the last-update list), else the stake program's
  `Split` fails;
- an instant exit must fit the reserve minus its rent;
- every amount goes out with a `..WithSlippage` floor (default 0.5 %);
- a pool that restricts SOL deposits or withdrawals to an authority is refused
  for that path rather than sent to fail.

## Why the instructions are hand-encoded

`@forgewallet/wallet-solana` is built on `@solana/*` 3.x. The published
stake-pool client wants web3.js v1 and `@solana-program/stake` wants kit ≥ 5;
either would put a second Solana stack into the consumer's bundle. The six
instructions this module needs have stable, documented layouts (Stake Pool
`DepositSol` 14 / `WithdrawStake` 10 / `WithdrawSol` 16 and their
`..WithSlippage` variants 25 / 24 / 26, System `CreateAccountWithSeed` 3,
Stake `Deactivate` 5 / `Withdraw` 4), verified against the program sources
and by simulation — `src/spl-stake-pool-codec.js` encodes them with
`@solana/addresses` and `@solana/instructions` only.

## Tests

```
npm test               # unit tests over mainnet fixtures (pool state, validator list, stake account)
npm run verify:live    # reads + simulateTransaction of every shape on mainnet, no keys
```

## License

Apache-2.0

## Activity

`describeActivity(tx, { own })` labels SPL Stake Pool transactions for a wallet's history, offline and synchronously. A transaction is this module's when the Stake Pool program `SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy` is among the programs it invoked (`call.programs` / `call.to`). The instruction tag — first byte of the stake-pool instruction's base58 `call.data` when the source passes it — picks the kind: `DepositSol` 14 / `DepositSolWithSlippage` 25 → `stake` "Staked SOL"; `WithdrawSol` 16 / 26 → `unstake` "Unstaked JitoSOL" (instant); `WithdrawStake` 10 / 24 → `unstake` "Requested unstake of JitoSOL" (delayed). Without data, the pool-token movement decides (minted to the wallet → stake, burned → unstake, with SOL arriving → instant). Pool tokens of every preset (`SPL_STAKE_POOL_ADDRESS_MAP`) and of the instance's pool are labelled and name the subtitle (`"Jito · Solana"`); an unknown pool on the same program is still recognized as `"SPL Stake Pool · Solana"`. `counterparty` is the pool account. Sweeping a finished delayed unstake (a Stake-program `withdraw` from a derived account) is not recognized — it carries no stake-pool instruction. `own` should contain the wallet **and** its token accounts: sources normalize SPL movements to owners, but a source that keeps token-account addresses still nets correctly when the ATA is in `own`.

Fixtures in `fixtures/activity/` are the test wallet's funded Jito run (DepositSol ×2, WithdrawSol ×3; 2026-09-07 … 10-07, from `getTransaction` jsonParsed); `negatives/` holds a plain SOL transfer and a plain JitoSOL SPL transfer (shapes only).

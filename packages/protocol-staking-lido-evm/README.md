# @anywalletkit/protocol-staking-lido-evm

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-staking-lido-evm?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-staking-lido-evm)

A simple package that lets `@anywalletkit/wallet-evm` wallet accounts stake
through the [Lido](https://lido.fi) protocol: stake ETH → stETH, exit through
the two-phase withdrawal queue, wrap/unwrap the non-rebasing wstETH form, and
read APR and reward history.

## Install

```sh
npm install @anywalletkit/protocol-staking-lido-evm @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-staking-lido-evm @anywalletkit/core  ·  yarn add @anywalletkit/protocol-staking-lido-evm @anywalletkit/core
```

On npm: [@anywalletkit/protocol-staking-lido-evm](https://www.npmjs.com/package/@anywalletkit/protocol-staking-lido-evm), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

Built as the first implementation of the **`StakingProtocol` type** in
`@anywalletkit/core`. The base class lives in `@anywalletkit/core`;
`src/staking-protocol.ts` keeps the runtime `IStakingProtocol` marker and the
option / result types this module documents. See "The interface" below for
why staking is not lending.

The mechanics are extracted from a production wallet (web + React
Native/Hermes) where every flow is exercised with real funds.

Written in TypeScript on [viem](https://viem.sh) (the only runtime
dependency) and built with tsup to `dist/` (ESM + CJS + `.d.ts`).

## Usage

```js
import WalletManagerEvm from '@anywalletkit/wallet-evm'
import LidoProtocolEvm from '@anywalletkit/protocol-staking-lido-evm'

const wallet = new WalletManagerEvm(seed, { provider: 'https://rpc.example.org' })
const account = await wallet.getAccount(0)

const lido = new LidoProtocolEvm(account, {
  referral: '0x…' // optional: Lido Rewards-Share referral, defaults to zero address
})

// Stake — stETH lands on the account 1:1
const { hash, fee } = await lido.stake({ amount: 10n ** 18n })

// Exit, phase 1: queue the withdrawal (permit-first — ONE transaction)
await lido.requestWithdrawal({ amount: 10n ** 18n, token: 'stETH' })

// …days later — exit, phase 2: claim finalized requests as ETH
const { claimableIds } = await lido.getWithdrawalRequests()
if (claimableIds.length) await lido.claimWithdrawals({ ids: claimableIds })

// Views
await lido.getStakedBalance() // { balance, wrappedBalance, rate, total }
await lido.getApr()           // 2.72 (percent, 7d SMA)
```

Lido-specific extras beyond the interface:

```js
await lido.wrap({ amount })                 // stETH → wstETH (approve awaited + wrap)
await lido.unwrap({ amount })               // wstETH → stETH (single tx)
await lido.getWithdrawalEta(ids)            // Map<id, seconds> from Lido's queue API
await lido.getRewards()                     // lifetime rewards + average APR
await lido.getRewardHistory({ limit: 14 })  // daily rebase events, newest first
```

## Why the withdrawal path looks the way it does

Every one of these choices was paid for in production:

- **Permit-first**: `requestWithdrawal` signs one EIP-2612 permit and rides it
  inside `requestWithdrawalsWithPermit` — a single transaction (and on mobile,
  a single biometric prompt) instead of approve + request.
- **Proven before broadcast**: the permit path is simulated with `eth_call`
  first. A bad signature must fall back, not burn gas.
- **The fallback awaits its approval**: in the approve + request path the
  approval is waited to a mined receipt, because the request's gas estimate
  reverts against an unmined allowance.
- **Verified permit domains**: stETH signs as version "2", wstETH as version
  "1" — both checked against the tokens' on-chain `DOMAIN_SEPARATOR`. A wrong
  version recovers to a different signer and reverts with no readable reason.
- **Per-request caps**: the queue takes at most 1000 stETH per request;
  over-cap amounts split into several requests inside the same transaction
  (wstETH capped at 800 per request — 1000 is stETH-equivalent and the rate
  drifts upward).
- **Up-front guards**: `stake` checks `isStakingPaused` and
  `getCurrentStakeLimit` before estimating gas, because the raw revert carries
  no readable reason for either.
- **Structural account checks**: writability is `typeof
  account.sendTransaction === 'function'`, not `instanceof` — a duplicated
  copy of the account package fails `instanceof` while the account works fine.
- **No `AbortSignal.timeout` / `AbortSignal.any`**: Hermes (React Native)
  ships `AbortController` but not those statics; nothing here depends on them.
- **REST endpoints are configuration**: APR, queue ETAs and reward history
  come from Lido's public frontend APIs (`eth-api.lido.fi`, `wq-api.lido.fi`,
  `reward-history-backend.lido.fi`), all overridable via `config.endpoints`.
  On-chain flows never depend on them: ETA and rewards are decoration and
  degrade to empty results, never throws.

## Configuration

```js
new LidoProtocolEvm(account, {
  provider,       // RPC url or EIP-1193; defaults to the account's provider
  chainId,        // default 1; other chains must supply the fields below
  referral,       // forwarded to submit() — Lido Rewards-Share integrators earn on stake flow
  addresses,      // { stEth, wstEth, withdrawalQueue }
  permitDomains,  // { stEth: { name, version }, wstEth: { name, version } }
  endpoints       // { apr, withdrawalQueueApi, rewardHistory }
})
```

Only mainnet ships as a default deployment — deliberately. Testnets (e.g.
Hoodi) must be configured explicitly so nobody stakes against an unverified
address a default quietly supplied.

## The interface

`IStakingProtocol`: `stake` / `quoteStake`, `requestWithdrawal` /
`quoteRequestWithdrawal`, `getWithdrawalRequests`, `claimWithdrawals` /
`quoteClaimWithdrawals`, `getStakedBalance`, `getApr`.

Staking is not lending: a lending `withdraw` is synchronous, while unstaking
is a two-phase exchange — a request enters a queue, finalizes out of band
(usually days), and only then can be claimed for the native token. Modelling
that as `ILendingProtocol.withdraw` would produce a method that returns with
no money received, and would stub out `borrow`/`repay` as unsupported. The
honest interface names the queue. Wrap/unwrap, ETAs and reward history stay
provider-specific extras so the core stays implementable by other liquid
staking protocols.

## Tests

```
pnpm build            # tsup → dist/
pnpm test             # offline unit + conformance tests (vitest, stubbed EIP-1193 provider)
pnpm verify:live      # read-only checks against mainnet (views, REST, eth_call simulation; needs dist/)
```

## Activity

`describeActivity(tx, { own })` labels Lido transactions for a wallet's history, offline and synchronously. A transaction is Lido's when it calls one of the three contracts the instance is configured with (`stEth`, `wstEth`, `withdrawalQueue` — mainnet by default) on that chain, and the selector is: stETH `submit` → `stake` "Staked ETH"; wstETH `wrap` → `wrap` "Wrapped stETH", `unwrap` → `unwrap` "Unwrapped wstETH"; WithdrawalQueue `requestWithdrawals` / `…WithPermit` / `…WstETH` / `…WstETHWithPermit` → `unstake` "Requested withdrawal", `claimWithdrawals` / `claimWithdrawalsTo` / `claimWithdrawal` → `claim` "Claimed ETH". Selectors are computed from the signatures at module load (`LIDO_ACTIONS`). `approve` / `transfer` on stETH or wstETH are not Lido operations and yield null, as does everything else. Subtitle `"Lido · Ethereum"`, `counterparty` the contract called; `assetsIn` / `assetsOut` are the wallet's net movements from the receipt with stETH / wstETH / unstETH labelled by the module.

Fixtures in `fixtures/activity/` are the test wallet's funded run (submit, wrap, unwrap, requestWithdrawalsWithPermit, claimWithdrawals; 2026-08-31 … 09-04); `negatives/` holds an SSV stake and a USDT approve.

# @forgewallet/protocol-staking-ssv-evm

A simple package that lets `@forgewallet/wallet-evm` wallet accounts stake
through [SSV Network](https://ssv.network): stake SSV → cSSV, claim the ETH
rewards, exit through the network's cooldown, and read APR and network stats.

Built as the **second implementation of the proposed `StakingProtocol` type**
for `@forgewallet/core` (the first is
`protocol-staking-lido-evm`).
staking. The base class in `src/staking-protocol.js` is the same file, written
to move into `@forgewallet/core` verbatim; a token-staking protocol
with a cooldown exit fitting it unchanged is the point: the interface is not
Lido-shaped.

The mechanics are extracted from a production wallet (React Native/Hermes)
where every flow is exercised with real funds.

## What SSV Network and the SSV token are

[SSV Network](https://ssv.network) is distributed validator technology (DVT)
for Ethereum: a validator's key is split among several independent operators,
so staking keeps running when any one of them is down or misbehaves. A large
share of Ethereum liquid staking runs its validators on it. Operators pay the
network's fees in ETH.

**SSV** is the network's ERC-20 token. Since SSV Network v2 (mainnet, 2026)
SSV holders can stake it: the network mints **cSSV** 1:1 — a transferable,
non-rebasing receipt token — and cSSV holders receive a pro-rata share of the
ETH fees, accrued block by block through an ETH-per-share index and claimable
at any time without unstaking. Staked weight also delegates voting power to the
network's Effective Balance oracles. Getting the SSV back is a cooldown exit:
`requestUnstake` burns cSSV into a cooldown entry (7 days at launch, DAO-tunable,
not cancellable), `withdrawUnlocked` pays out every entry whose cooldown has
ended. There is no slashing for stakers. The APR is ETH-denominated on an
SSV-denominated stake, so it moves with SSV's price.

## Usage

```js
import WalletManagerEvm from '@forgewallet/wallet-evm'
import SsvProtocolEvm from '@forgewallet/protocol-staking-ssv-evm'

const wallet = new WalletManagerEvm(seed, { provider: 'https://rpc.example.org' })
const account = await wallet.getAccount(0)

const ssv = new SsvProtocolEvm(account)

// Stake — approve (awaited) + stake on the first go, one transaction after
const { hash, fee, approveHash } = await ssv.stake({ amount: 10n ** 18n })

// Rewards accrue in ETH; claim any time, the stake stays put
await ssv.getClaimableRewards()            // wei
await ssv.claimRewards()

// Exit, phase 1: burn cSSV into a cooldown entry (irreversible)
await ssv.requestWithdrawal({ amount: 10n ** 18n })

// …after the cooldown — exit, phase 2: withdraw every unlocked entry as SSV
const { claimableIds } = await ssv.getWithdrawalRequests()
if (claimableIds.length) await ssv.claimWithdrawals()

// Views
await ssv.getStakedBalance()   // { balance: cSSV, wrappedBalance: 0n, rate: 1e18, total }
await ssv.getApr()             // 23.8 (percent, from SSV Network's API)
```

SSV-specific extras beyond the proposed interface:

```js
await ssv.getTokenBalance()          // liquid SSV on the account
await ssv.getClaimableRewards()      // accrued ETH (wei)
await ssv.claimRewards()             // claimEthRewards()
await ssv.getCooldown()              // seconds — read it, never hardcode 7 days
await ssv.getNetworkStats()          // { totalStaked, rewardsPool, accEthPerShare }
await ssv.getAprHistory({ limit: 7 })// daily samples with SSV/ETH prices
```

## How it maps onto the proposed interface

| `IStakingProtocol` | SSV Network |
|---|---|
| `stake({ amount })` | allowance check → `approve` (awaited to a mined receipt) → `stake` on the SSVNetwork proxy; cSSV minted 1:1 |
| `requestWithdrawal({ amount })` | `requestUnstake` — burns cSSV into a cooldown entry; `token` ignored (single staked form) |
| `getWithdrawalRequests()` | `pendingUnstake` → entries with `id` = position, `unlockTime`, `claimable = unlockTime <= now`; amounts are **SSV** |
| `claimWithdrawals()` | `withdrawUnlocked` — pays **every** unlocked entry; `ids` are informational |
| `getStakedBalance()` | cSSV balance, `wrappedBalance` 0, `rate` 1e18 |
| `getApr()` | `api.ssv.network/…/apr/current` — the number stake.ssv.network shows |

Two honest differences from Lido are documented on the methods rather than
papered over: the exit pays the staked token (SSV), not the chain's native
token, and the withdraw call is all-or-nothing on the network side.

## Why the write path looks the way it does

- **No permit anywhere**: neither SSV nor cSSV implements EIP-2612 (checked:
  `nonces` / `DOMAIN_SEPARATOR` revert on both). The first stake is therefore
  approve + stake; the approval is **awaited to a mined receipt** because
  `stake`'s gas estimate reverts against an unmined allowance. With a
  standing allowance it is one transaction.
- **Proven before broadcast**: every write is simulated with `eth_call` from
  the account first. The staking module reverts with bare custom errors —
  `StakeTooLow`, `UnstakeAmountExceedsBalance`, `NothingToWithdraw`,
  `NothingToClaim`, `InsufficientBalance`… — and `describeRevert` turns the
  4-byte selector back into a named error, wherever ethers buried it
  (`error.data`, `info.error.data`, `cause`, or the message text). A user
  sees "no unstake request has finished its cooldown yet", not "execution
  reverted", and pays no gas for it.
- **Claim rounding**: `claimEthRewards` pays `accrued − accrued % 100000 wei`
  and reverts when that is zero; `claimRewards` checks `previewClaimableEth`
  against `ETH_CLAIM_UNIT` up front.
- **Unstable ids**: cooldown entries are addressed by position and
  `withdrawUnlocked` compacts the list — re-read `getWithdrawalRequests`
  after every write; nothing here caches ids.
- **Structural account checks**: writability is `typeof
  account.sendTransaction === 'function'`, not `instanceof`.
- **No `AbortSignal.timeout` / `AbortSignal.any`**: Hermes ships
  `AbortController` without those statics; nothing here depends on them.
- **REST is decoration**: APR and APR history come from the same API
  stake.ssv.network reads (CORS `*`), overridable via `config.endpoints`;
  the on-chain flows never depend on them, and `getAprHistory` degrades to an
  empty array.

## Configuration

```js
new SsvProtocolEvm(account, {
  provider,   // RPC url or EIP-1193; defaults to the account's provider
  chainId,    // default 1; other chains must supply addresses
  addresses,  // { network, views, ssvToken, cssvToken }
  endpoints   // { apr, aprHistory }
})
```

Only mainnet ships as a default deployment — deliberately. The Hoodi testnet
addresses are listed in `src/ssv-address-map.js` for explicit configuration,
so nobody stakes against an address a default quietly supplied.

Mainnet contracts (verified on-chain against the live proxy, v2.0.0):
SSVNetwork `0xDD9BC35aE942eF0cFa76930954a156B3fF30a4E1`, SSVNetworkViews
`0xafE830B6Ee262ba11cce5F32fDCd760FFE6a66e4`, SSV
`0x9D65fF81a3c488d585bBfb0Bfe3c7707c7917f54`, cSSV
`0xe018D31F120A637828F46aFD6c64EC099d960546`.

## Tests

```
npm test              # offline unit tests (node:test, stubbed EIP-1193 provider)
npm run verify:live   # read-only checks against mainnet (views, API, eth_call proofs)
```

## Activity

`describeActivity(tx, { own })` labels SSV staking transactions for a wallet's history, offline and synchronously. A transaction is SSV's when it calls the `network` proxy the instance is configured with (mainnet by default) on that chain and the selector is `stake` → `stake` "Staked SSV", `requestUnstake` → `unstake` "Requested unstake", `withdrawUnlocked` → `claim` "Withdrew SSV", `claimEthRewards` → `claim` "Claimed ETH rewards" (`SSV_ACTIONS`, selectors computed from the signatures at module load). Operator / cluster management calls on the same proxy, SSV `approve`s and anything else yield null. Subtitle `"SSV Network · Ethereum"`, `counterparty` the proxy; `assetsIn` / `assetsOut` are the wallet's net movements (SSV, cSSV, ETH rewards) labelled by the module.

Fixtures in `fixtures/activity/` are the test wallet's funded run (stake, requestUnstake ×2, withdrawUnlocked, claimEthRewards; 2026-09-03 … 10-07); `negatives/` holds a Lido submit and a USDT approve.

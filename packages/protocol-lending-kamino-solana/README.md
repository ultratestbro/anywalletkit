# @anywalletkit/protocol-lending-kamino-solana

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-lending-kamino-solana?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-lending-kamino-solana)

[Kamino](https://kamino.com/docs) for `@anywalletkit/wallet-solana` accounts, two
`LendingProtocol`s in one package:

## Install

```sh
npm install @anywalletkit/protocol-lending-kamino-solana @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-lending-kamino-solana @anywalletkit/core  ·  yarn add @anywalletkit/protocol-lending-kamino-solana @anywalletkit/core
```

On npm: [@anywalletkit/protocol-lending-kamino-solana](https://www.npmjs.com/package/@anywalletkit/protocol-lending-kamino-solana), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

- **`KaminoVaultProtocolSolana`** — one Kamino Earn vault (kVault): `supply`
  deposits the vault's asset for shares (kept in the wallet, where the guard
  proves they arrive; `skipFarm: false` stakes them in the vault farm as the
  Kamino app does — the guard then pins the stake to this vault's farm and the
  wallet's farm state, but cannot count the shares), `withdraw` redeems shares for the
  asset. The simplest Earn product; `borrow` / `repay` reject.
- **`KaminoMarketProtocolSolana`** — one Kamino Lend market (the Main Market
  by default): `supply` / `withdraw` post and take collateral on the wallet's
  obligation, `borrow` / `repay` take and return a reserve's liquidity against
  it. Tokens are named by mint.

## How a transaction is trusted

Kamino's official API builds every transaction (`POST /ktx/…` — the same
builder the Kamino app and SDK use: farms, lookup tables, obligation setup).
The module never signs it as-is. The wallet's serialized-transaction guard
(`wallet-solana`'s `checkSerialized` / `sendSerialized`) proves it first:

1. every program it invokes is on the Kamino allowlist — Kamino Lend, kVault,
   Farms, the address-lookup-table program and the token / system / compute
   budget / memo programs, nothing else;
2. every instruction is one the operation takes (`marketRules` /
   `vaultRules`), with the accounts that decide where value goes pinned: the
   wallet, its vanilla obligation, the configured market or vault, the
   reserve and mint the call names, the wallet's own token accounts, this
   vault's farm. A deposit carries refreshes, set-up and the deposit; a
   withdrawal inside it, a borrow inside a repay, a token transfer, an
   `invest` or a reward harvest is refused (`unexpected-instruction`);
3. the compiled-transaction checks pass (this wallet is the fee payer, no
   foreign co-signers, no authority or delegate changes);
4. a simulation with post-state accounts shows exactly the balance changes
   the module declared: on a deposit the amount out and at most rent in SOL
   on top, on a withdrawal / borrow the asset in at the minimum
   (`slippageBps`, default 0.5 %) — a borrow at most what was asked — no
   other token account of ours touched.

Only after all four does the account sign. A first Lend deposit also pays the
rent of the obligation, user metadata and a per-user lookup table
(`firstDepositAllowanceLamports`, default 0.045 SOL); later ones only the
usual `rentAllowanceLamports` (0.01 SOL). Whether it is a first deposit is
read from the chain (does the vanilla obligation's account exist).

The bounds come from the chain, read through the account
(`getAccountInfos`, `@anywalletkit/wallet-solana` 0.4+): a vault's share
price from its state and the reserves it invests in, the wallet's shares
from its shares account and farm stake, a Lend 'max' from the obligation
(debt with the reserve's accrued interest), and the reserve the API names
must be this market's and lend that token. An API figure that disagrees —
a `tokensPerShare` more than 1 % off, a reported deposit or debt that is not
the obligation's, any negative figure — is refused, never used. Reads
(`getVault`, `getPosition`, APY, TVL) stay the API's; mint decimals are read
when the account has an RPC, else taken from a table of Kamino's listed mints.

## Usage

```ts
import WalletManagerSolana from '@anywalletkit/wallet-solana'
import { KaminoApi, KaminoVaultProtocolSolana, KaminoMarketProtocolSolana } from '@anywalletkit/protocol-lending-kamino-solana'

const account = await new WalletManagerSolana(seed, { provider: 'https://…' }).getAccount(0)
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

// Discovery: the USDC Earn vaults, biggest first
const api = new KaminoApi()
const vaults = (await api.listVaults()).filter((v) => v.tokenMint === USDC).sort((a, b) => Number(b.sharesIssued - a.sharesIssued))

// Earn vault
// `asset`: the API's answer must name it, and deposits need it (or a `token` per call). The vault's
// address, program and shares mint (the PDA ["shares", vault]) are checked too, before anything is built.
const vault = new KaminoVaultProtocolSolana(account, { vault: vaults[0].address, asset: USDC })
await vault.getVault()                       // asset, shares, APY (net, %), fees, TVL, minimums, allocations
await vault.quoteSupply({ amount: 5_000_000n })   // { fee, expectedShares } — built, proven, not signed
await vault.supply({ amount: 5_000_000n })        // { hash, fee }
await vault.getPosition()                    // { shares, stakedShares, unstakedShares, assets }
await vault.withdraw({ amount: 'max' })      // every share → asset, min = assets × (1 − slippage)

// Lend market
const market = new KaminoMarketProtocolSolana(account)          // Main Market
await market.getReserves()                   // symbol, mint, supply / borrow APY (%), max LTV, TVL, utilization
await market.supply({ token: USDC, amount: 5_000_000n })        // collateral on the wallet's obligation
await market.borrow({ token: USDC, amount: 1_000_000n })
await market.getPosition()                   // { obligations, supplied: {mint: units}, borrowed }
await market.repay({ token: USDC, amount: 'max' })
await market.withdraw({ token: USDC, amount: 'max' })
```

A mint with several reserves in a market (the Main Market has four USDC
reserves) resolves to the deepest one by supplied value; pin another with
`reserves: { [mint]: reserveAddress }`.

## Config

| option | default | |
| --- | --- | --- |
| `api` | `https://api.kamino.finance` | endpoint or a `KaminoApi` |
| `slippageBps` | 50 | floor on what the wallet must receive (withdraw, borrow); ceiling on a repay |
| `rentAllowanceLamports` | 0.01 SOL | SOL a transaction may spend beyond the amount |
| `memo` | — | SPL memo the API adds |
| vault: `vault`, `asset`, `skipFarm` | — / — / true | the kVault; the asset it must take; keep shares in the wallet (`false`: stake them in this vault's farm; the guard then proves the spend and pins the stake to the wallet's farm state) |
| market: `market`, `reserves`, `firstDepositAllowanceLamports` | Main Market / — / 0.045 SOL | |

## Verify

`pnpm test` (fixtures copied from live API responses). `pnpm verify:live
[address]` reads markets, reserves and vaults from the API, then builds a vault
deposit and a Lend deposit for the address and runs both through the guard as
a read-only account (no keys, no writes).

Program ids: Kamino Lend `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`, kVault
`KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd`, Farms
`FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr`. `instructionName()` names the
Anchor instructions the API's transactions carry, for review screens;
`decodeVault` / `decodeReserve` / `decodeObligation` / `decodeFarmUser` read
the accounts the bounds come from, and `vaultTokensPerShareWad` / `debtNow`
compute from them what the module does.

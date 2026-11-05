# @anywalletkit/protocol-lending-curve-evm

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-lending-curve-evm?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-lending-curve-evm)

[Curve](https://docs.curve.finance) lending for `@anywalletkit/wallet-evm` accounts. So far one
`LendingProtocol`:

- **`ScrvUsdProtocolEvm`** — Savings crvUSD (scrvUSD) on Ethereum: `supply` deposits crvUSD for
  scrvUSD shares, `withdraw` redeems them. A stable "earn" on crvUSD; `borrow` / `repay` reject.

LlamaLend lend vaults (`CurveLendVaultProtocolEvm`, a curated market list per chain) are planned
for this package and will share its plumbing; they are not built yet.

## Install

```sh
npm install @anywalletkit/protocol-lending-curve-evm @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-lending-curve-evm @anywalletkit/core  ·  yarn add @anywalletkit/protocol-lending-curve-evm @anywalletkit/core
```

On npm: [@anywalletkit/protocol-lending-curve-evm](https://www.npmjs.com/package/@anywalletkit/protocol-lending-curve-evm), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

Written from Yearn's VaultV3.vy 3.0.4 (the code scrvUSD runs) and Curve's docs; one dependency
(viem). The Curve prices API is used only to decorate the APY; every money path reads the chain.

## Chains

Ethereum only. scrvUSD is a vault there alone: on Arbitrum, Base, OP Mainnet, Fraxtal and others
"scrvUSD" is a bridged ERC-20 whose `totalAssets` / `asset` revert, so earning on those chains
means swapping crvUSD for it. The constructor refuses any other chain.

## Usage

```ts
import WalletManagerEvm from '@anywalletkit/wallet-evm'
import { ScrvUsdProtocolEvm } from '@anywalletkit/protocol-lending-curve-evm'

const account = await new WalletManagerEvm(seed, { provider: 'https://ethereum-rpc…' }).getAccount(0)
const scrvusd = new ScrvUsdProtocolEvm(account)

await scrvusd.getVault()                        // verified; totalAssets, totalIdle, totalDebt, share price, unlock state…
await scrvusd.getApy()                          // 6.28 (percent, projected, variable)
await scrvusd.getApyDetails()                   // { apy, source: 'api' | 'api-clamped' | 'chain', chainApy, apiApy, block, unlockingUntil }
await scrvusd.quoteSupply({ amount: 100n * 10n ** 18n })   // fee, sharesOut (previewDeposit), approvals needed
await scrvusd.supply({ amount: 100n * 10n ** 18n })        // exact approve → deposit(assets, me)
await scrvusd.getPosition()                     // { shares, assets, withdrawable, redeemableShares }
await scrvusd.withdraw({ amount: 'max' })       // redeem(every share, me, me, max_loss = 0)
await scrvusd.withdraw({ amount: 50n * 10n ** 18n })       // withdraw(assets, me, me, max_loss = 0)
```

Amounts are crvUSD base units (18 decimals) as bigints; shares have 18 decimals too.

### How the yield works

scrvUSD is an unmodified Yearn V3 vault that holds crvUSD idle: no strategies, nothing lent out,
so withdrawals are instant. Its yield is a share of crvUSD borrowing fees, which Curve's
FeeSplitter sends to the vault roughly weekly. A report does not raise the share price at once:
VaultV3 locks the profit as shares and burns them linearly over `profitMaxUnlockTime`
(604 800 s = **7 days**), so the price per share rises smoothly until `fullProfitUnlockDate`.
Consequences for a wallet:

- **The APY is variable and projected.** It follows from the profit currently unlocking:
  APR = `profitUnlockingRate` / 1e12 × seconds per year / `totalSupply`, APY = e^APR − 1. It
  changes with every report and also with every deposit or withdrawal (`totalSupply`), and it is
  0 once the profit has fully unlocked until the next report. Show it as an estimate.
- **A deposit starts earning right away** on the profit still unlocking; there is no entry delay.
- **Profit is never paid out at once**, so a deposit right before a report cannot capture a week's
  yield in one block.

### Safety before money moves

- **Vault identity**, checked once per instance before any read for a write (`verify()`): the
  read RPC is on Ethereum; the code at `0x0655977F…4367` is exactly the 45-byte EIP-1167 clone
  pointing at the pinned implementation `0xd8063123…b00d`; that implementation's code hash is the
  pinned VaultV3 3.0.4 one; `apiVersion()` is "3.0.4"; `asset()` is crvUSD `0xf939E0A0…1b4E`.
  Anything else is a `ScrvUsdVerificationError` (`code: 'ScrvUsdVerificationFailed'`, `check`,
  `expected`, `observed`) and nothing is approved or sent, withdrawals included. A failed read
  propagates: an unanswered check never counts as a pass. Addresses are never resolved through
  Curve's AddressProvider or API.
- **Deposits** read `isShutdown`, `totalDebt` and `maxDeposit` fresh: a shut-down vault refuses
  with `VaultShutdownError` (`'VaultShutdown'`); a vault that started lending to strategies
  (`totalDebt > 0`, which Yearn V3 allows its role manager to set up) refuses with
  `'StrategiesInUse'` unless `allowStrategies: true`; above the deposit limit, `'ExceededMaxDeposit'`
  says how much is possible.
- **Withdrawals** stay open when the vault is shut down. They always pass `max_loss = 0`
  explicitly: VaultV3's three-argument `redeem` defaults it to 10 000 bps, any loss. `'max'`
  redeems the whole balance when the vault can pay it (VaultV3's own `maxRedeem` rounds one unit
  short) and otherwise what `maxRedeem(owner, 0)` allows, with `complete: false`; an amount above
  `maxWithdraw(owner, 0)` is refused with `'ExceededMaxWithdraw'` and the amount available.
- **Proof.** Every main transaction is `eth_call`ed from the account first; VaultV3's revert
  strings (`exceed deposit limit`, `too much loss`, …) become readable `CurveLendingError`s.
- **Approvals** are exact (never unlimited), to the vault only, with an `approve(0)` reset before
  raising a non-zero allowance. crvUSD only: no native-coin path.
- **APY from the API, bounded by the chain.** `getApyDetails()` reads the vault's unlock state at
  one block and the API's `proj_apy`; the API figure is shown only within `APY_TOLERANCE` (0.5
  percentage points or 10 %, whichever is larger) of the on-chain projection and clamped to that
  band otherwise (`source: 'api-clamped'`). Without the API (`api: null`, an outage, a malformed
  answer, a 15 s timeout) the on-chain projection is used. The API endpoint must be https on
  `curve.finance` or a subdomain: curve.fi (hijacked at the registrar in 2025) and other hosts are
  refused at construction.
- **No dead-deposit gate**: VaultV3 accounts assets internally (`totalIdle`), not by balance, so
  donations do not move its share price, and the vault holds ~15M crvUSD.

### Reads

| | returns |
| --- | --- |
| `getVault()` | identity, name, asset, totalAssets / totalSupply / totalIdle / totalDebt, price per share, isShutdown, profit unlock state, role manager, block |
| `getPosition(user?)` | shares, assets, withdrawable now, redeemable shares |
| `getApy()`, `getApyDetails()` | APY % and how it was bounded |
| `getStats()` | the Curve API record (projected APY, supply, block) or null |

## Tests

`pnpm test` — offline tests over an in-memory scrvUSD carrying the vault's real clone code and the
implementation's real VaultV3 3.0.4 code (`tests/fixtures/vault-v3-3.0.4.runtime.hex`), the live
2026-11-05 share price and unlock state, and crvUSD: every identity check failing on its own
(clone, implementation, apiVersion, asset, chain), RPC failures refusing instead of passing,
shutdown, strategies, limits, exact approvals and resets, 18-decimal share / asset maths, the
`maxRedeem` rounding, APY maths and clamping, the API host allowlist and timeout, plus the
conformance suite. `pnpm verify:live` reads Ethereum through a public RPC (`CURVE_RPC`, holder
`CURVE_USER`): the identity checks, state, APY against the API, a holder's position and redeem
proof, then the module's own deposit → redeem → withdraw calldata proven for an empty address
under an `eth_call` state override (crvUSD balance and allowance, then shares).

## Status

2026-11-05: built, offline tests green, live read-only verification on Ethereum (including the
state-override deposit / redeem proofs). No funded transaction through the module yet.

## Activity

`describeActivity(tx, { own })` labels scrvUSD transactions for a wallet's history, offline and synchronously:

- **Vault calls** are recognized **by address**: the called contract is the pinned scrvUSD vault and the selector is a VaultV3 entry point, `deposit` / `mint` → `supply`, `withdraw` / `redeem` in every arity Vyper compiles (3, 4 or 5 arguments) → `withdraw`.
- **The deposit allowance**: `approve(scrvUSD, amount)` on crvUSD → `approve` (`revoke` for 0). An approval for another spender is left to other modules.
- **Through another contract** (a smart wallet, a multicall): scrvUSD minted from `0x0` to one of the wallet's addresses → `supply`, burned from it → `withdraw`. Buying or selling scrvUSD on a DEX moves existing shares and is not matched.
- **Title** `"Deposited crvUSD"` / `"Withdrew crvUSD"`, **subtitle** `"Savings crvUSD · Ethereum"`, `counterparty` the contract called, `protocol` the package name; `assetsIn` / `assetsOut` are the wallet's net movements (shares included).
- **Null** otherwise, and on every chain but Ethereum.

Fixtures in `fixtures/activity/` are one public account's full cycle on Ethereum (approve 753 000 crvUSD, `deposit`, then the three-argument `redeem`), captured with `scripts/capture-fixtures.mjs`; `negatives/` a plain scrvUSD transfer, an approval on the share token itself and a Morpho vault deposit on Base.

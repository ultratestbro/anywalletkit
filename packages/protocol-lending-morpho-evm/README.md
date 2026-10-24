# @anywalletkit/protocol-lending-morpho-evm

[Morpho](https://docs.morpho.org) for `@anywalletkit/wallet-evm` accounts, two
`LendingProtocol`s in one package:

- **`MorphoVaultProtocolEvm`** — a Morpho Vault (MetaMorpho / Vault V1, or Vault
  V2): `supply` deposits the vault's asset for shares, `withdraw` redeems them.
  The simplest Earn product; `borrow` / `repay` reject.
- **`MorphoMarketProtocolEvm`** — one Morpho Blue market: `supply` / `withdraw`
  lend the loan token, `supplyCollateral` / `withdrawCollateral` post and take
  collateral, `borrow` / `repay` take and return the loan token against it.

Written from the protocol's own interfaces (morpho-blue, metamorpho, vault-v2)
with the shares and interest maths ported from `SharesMathLib` / `MathLib` /
`Morpho._accrueInterest`; one dependency (viem). The Morpho GraphQL API is used
only for discovery and decoration (listing, APY, TVL); every money path reads
the chain.

## Chains

Ethereum, Base, Arbitrum, OP Mainnet, Polygon, Unichain, HyperEVM, Katana,
Monad, Robinhood Chain (`MORPHO_CHAINS`). The Morpho (Blue) addresses come from
docs.morpho.org; the vault factories are the ones behind every vault the Morpho
API lists (the docs carry no factory table). Other chains take `morpho` in the
config.

## Usage

```ts
import WalletManagerEvm from '@anywalletkit/wallet-evm'
import { MorphoVaultProtocolEvm, MorphoMarketProtocolEvm, MorphoApi } from '@anywalletkit/protocol-lending-morpho-evm'

const account = await new WalletManagerEvm(seed, { provider: 'https://base-rpc…' }).getAccount(0)

// Discovery (API): the listed USDC vaults on Base, biggest first
const api = new MorphoApi()
const [best] = await api.listVaults({ chainId: 8453, asset: USDC })

// Vault
const vault = new MorphoVaultProtocolEvm(account, { vault: best.address })
await vault.getVault()                          // verified against Morpho's factories; asset, fees, timelock…
await vault.getApy()                            // 4.1 (net, percent, from the API)
await vault.supply({ amount: 5_000_000n })      // exact approve → deposit(assets, me)
await vault.getPosition()                       // { shares, assets, withdrawable }
await vault.withdraw({ amount: 'max' })         // redeem(every share) — refused up front if the vault lacks liquidity

// Market (Blue)
const market = new MorphoMarketProtocolEvm(account, { market: '0x9103…1836' })   // id or MarketParams
const m = await market.getMarket()              // loan/collateral tokens, LLTV, price, state accrued to now, APYs, liquidity
await market.supplyCollateral({ amount: 10n ** 7n })        // 0.1 cbBTC
await market.borrow({ amount: 3_000_000_000n })            // 3 000 USDC — refused if above LLTV or market liquidity
await market.getPosition()                      // debt (rounded up), collateral value, health factor, liquidation price
await market.repay({ amount: 'max' })           // by shares, no dust; allowance = debt + 0.1 %
await market.withdrawCollateral({ amount: 'max' })
```

### Safety before money moves

- **Vault identity.** `getVault()` asks the chain's Morpho vault factories
  (`isMetaMorpho` / `isVaultV2`) whether they created the address, and a V1
  vault's `MORPHO()` must be the chain's singleton. An unknown address is
  refused unless `allowUnverifiedVault: true`.
- **Vault limits.** Deposits are checked against `maxDeposit` (caps, V2 gates),
  withdrawals against `maxWithdraw` / `maxRedeem` (vault liquidity) — the error
  says how much *is* possible right now. V2 transfer gates are read too.
- **Market identity.** An id is resolved with `idToMarketParams`; params are
  hashed to the id and the market must exist (`lastUpdate ≠ 0`). The golden
  test derives the live Base cbBTC/USDC id from its params.
- **Market state.** `market()` is accrued to now exactly as `accrueInterest`
  would (Taylor-compounded borrow rate from the IRM, fee shares), so supplied
  / borrowed assets, health and liquidity are current, not last-touch.
- **Health.** Borrows and collateral withdrawals are checked against
  `collateral × price / 1e36 × LLTV`; liquidity against supply − borrow.
  `onBehalfOf` borrows need `isAuthorized`.
- **Proof.** Every main transaction is `eth_call`ed from the account; Morpho's
  revert strings (`insufficient liquidity`, `insufficient collateral`, …) and
  the vaults' custom errors (`AllCapsReached`, `ERC4626ExceededMaxWithdraw`,
  V2 `CannotReceiveShares`, …) become readable `MorphoError`s.
- **Approvals** are exact (never unlimited), with the `approve(0)` reset
  Ethereum's USDT demands. Morpho has no native-coin path: wrap first.

### Reads

| | returns |
| --- | --- |
| `vault.getVault()` | version, factory, name, asset, totalAssets, share price, fees, timelock, curator |
| `vault.getPosition()` | shares, assets, withdrawable now |
| `vault.getApy()`, `vault.getStats()` | net APY %, API record |
| `market.getMarket()` | params, tokens, LLTV, oracle price (1e36), accrued state, liquidity, utilization, borrow/supply APY |
| `market.getPosition(user?)` | supply/borrow shares and assets, collateral, collateral value, max borrow, health factor, LTV, liquidation price |
| `MorphoApi.listVaults / listMarkets / vault / marketById` | discovery, biggest first, `listed: true` |

## Tests

`pnpm test` — 27 offline tests over an in-memory Morpho on Base (Blue
singleton with the real cbBTC/USDC market params, IRM, oracle, a MetaMorpho
vault behind the v1.0 factory, a look-alike vault, Multicall3, reverts) plus
the conformance suite for both protocols. `pnpm verify:live` reads Base
through a public RPC and the API.

## Status

2026-10-10: built, offline tests green, live read-only verification on Base.
No funded transaction through the module yet (plan: 5 USDC into a Base vault,
withdraw).

## Activity

`describeActivity(tx, { own })` labels Morpho transactions for a wallet's history, offline and synchronously (shared by both classes through `MorphoBase`):

- **Blue** is recognized **by address**: the called contract is the Morpho singleton of the transaction's chain (`MORPHO_CHAINS`, or the `morpho` this instance was configured with) and the selector is `supply` / `withdraw` / `borrow` / `repay` / `supplyCollateral` / `withdrawCollateral` (→ `supply` / `withdraw` / `borrow` / `repay`) or `setAuthorization` (→ `contract`). The principal asset is `MarketParams.loanToken` from calldata when present.
- **Vaults** (MetaMorpho / Vault V1, Vault V2) cannot be listed offline — they come from factories and the `isMetaMorpho` / `isVaultV2` proof needs a node — so the rule is: the selector is an ERC-4626 entry point (`deposit` / `mint` → `supply`, `withdraw` / `redeem` → `withdraw`) **and** the called contract is itself the share token the receipt shows minted to (deposit) or burned from (withdraw) one of the wallet's addresses, on a chain with a Morpho deployment. The vault a `MorphoVaultProtocolEvm` instance is configured with is accepted by address alone. *Caveat:* any ERC-4626 vault on a Morpho chain satisfies the generic rule; the kit asks modules in registry order, so a module that knows a specific vault should be registered before this one.
- **Title** `"<Verb> <asset>"` ("Deposited USDC", "Withdrew USDC"; the share token is never the principal), **subtitle** `"Morpho · <chain>"` / `"Morpho Vault · <chain>"`, `counterparty` the contract called, `protocol` the package name; `assetsIn` / `assetsOut` are the wallet's net movements (shares included).
- **Null** otherwise.

Fixtures in `fixtures/activity/` are public Base transactions (a Moonwell Flagship USDC vault `deposit` / `redeem` by one account, a Blue `supply` / `withdraw` by another; the test wallet has not run Morpho yet), `negatives/` an Aave gateway deposit and a plain USDC transfer.

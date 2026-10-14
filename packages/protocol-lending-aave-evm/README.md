# @forgewallet/protocol-lending-aave-evm

[Aave v3](https://aave.com/docs) for `@forgewallet/wallet-evm` accounts: supply,
withdraw, borrow (variable rate) and repay on any Aave v3 market, with the reads
a wallet screen needs — reserves with rates and caps, the account's health
factor and borrowing power, the position. Implements core's `LendingProtocol`
(`supply / withdraw / borrow / repay` + quotes), like
`@forgewallet/protocol-lending-mellow-evm` does for vaults.

Written from the protocol's own interfaces (aave-v3-origin) and the official
address book (bgd-labs/aave-address-book); no Aave SDK, one dependency (viem).

## Markets

Every live Aave v3 market ships as a preset (`AAVE_MARKETS[chainId][key]`):
Ethereum (`core`, `lido`, `etherfi`), Arbitrum, Optimism, Polygon, Base,
Avalanche, BNB, Gnosis, Scroll, Linea, Sonic, Celo, Mantle, Soneium, Plasma,
zkSync, Metis, Ink. A market not in the list takes `addressesProvider` (and
`pool`) in the config.

Only the **PoolAddressesProvider** is trusted from configuration. The Pool,
price oracle and data provider are read from it on-chain, and the preset's Pool
must match what the provider reports — a stale or wrong entry refuses instead
of sending money to the wrong contract.

## Usage

```ts
import WalletManagerEvm from '@forgewallet/wallet-evm'
import { AaveProtocolEvm } from '@forgewallet/protocol-lending-aave-evm'

const account = await new WalletManagerEvm(seed, { provider: 'https://…' }).getAccount(0)
const aave = new AaveProtocolEvm(account)              // chain from the account, market 'core'
// new AaveProtocolEvm(account, { market: 'lido' })    // Ethereum Lido instance
// new AaveProtocolEvm(account, { chainId: 8453 })     // Base, with an explicit chain

const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'

await aave.getSupplyApy(USDT)                          // 3.9 (percent, compounded like Aave's UI)
await aave.quoteSupply({ token: USDT, amount: 100_000_000n })   // { fee, approvals, permit, supplyApy }
await aave.supply({ token: USDT, amount: 100_000_000n })        // approve (exact) → wait → Pool.supply
await aave.supply({ token: 'native', amount: 10n ** 17n })      // WrappedTokenGatewayV3.depositETH

await aave.borrow({ token: USDT, amount: 50_000_000n })         // variable rate, checked against borrowing power
await aave.repay({ token: USDT, amount: 'max' })                // whole debt (+0.1 % approved for accruing interest)
await aave.withdraw({ token: USDT, amount: 'max' })             // uint256.max → everything
await aave.setCollateral({ token: USDT, enabled: false })

const { account: data, supplies, borrows } = await aave.getPosition()
data.healthFactor                                      // 2.6, or Infinity without debt
```

### What happens before money moves

- The reserve must be active, not paused, and not frozen (frozen allows only
  withdraw and repay). Supply and borrow caps are checked against the aToken /
  debt-token supply.
- Borrows are compared with `getUserAccountData().availableBorrowsBase` at the
  oracle price, so an over-borrow is refused with the numbers instead of a bare
  revert. Credit delegation (`onBehalfOf`) is checked via `borrowAllowance`.
- Every main transaction is proven with `eth_call` from the account; Aave's
  reverts — numeric codes on v3.0–3.3 (`'35'`), custom errors on v3.4+
  (`HealthFactorLowerThanLiquidationThreshold()`) — become readable
  `AaveError`s with the code attached.
- ERC-20 allowances are **exact**, never unlimited; Ethereum's USDT gets the
  `approve(0)` reset it demands. When the token supports EIP-2612 and the
  account can `signPermit` (wallet-evm does), supply and repay take the
  one-transaction `supplyWithPermit` / `repayWithPermit` road.
- Native legs go through WrappedTokenGatewayV3: `depositETH`, `withdrawETH`
  (after approving the aWETH to the gateway), `borrowETH` (after
  `approveDelegation` on the WETH debt token), `repayETH` (excess refunded).
  The gateway ABI is the v3.2+ one verified on Ethereum — `borrowETH` and
  `repayETH` no longer take a rate mode, unlike the protocol docs still show.

### Reads

| method | returns |
| --- | --- |
| `getMarket()` | pool, oracle, data provider, base currency unit, gateway, wrapped native |
| `getReserves()` / `getReserve(token)` | configuration bits decoded (LTV, thresholds, caps, flags), rates (ray, APR, APY), aToken / debt token |
| `getUserAccountData(user?)` | collateral, debt, borrowing power in base currency; LTV, liquidation threshold, health factor |
| `getPosition()` | supplies (with the collateral flag) and borrows per reserve, plus the account data |
| `getAssetPrice(token)`, `getSupplyApy(token)`, `getBorrowApy(token)` | oracle price; APYs in percent |

Reserve reads go through Multicall3 (one round trip) and fall back to single
calls where it is absent (zkSync).

## Config

| key | default | meaning |
| --- | --- | --- |
| `chainId` | account's chain, else 1 | must match the account's `eip155:N` |
| `market` | `'core'` | preset key for the chain |
| `addressesProvider`, `pool`, `wethGateway` | from the preset | explicit market; `wethGateway: null` disables native legs |
| `provider` | the account's | RPC url(s) / EIP-1193 to read through |
| `usePermit` | `true` | one-transaction supply / repay when possible |
| `referralCode` | `0` | inactive on every market |
| `waitTimeoutMs` | 180 000 | how long an approval may take to mine |
| `multicall` | Multicall3 | address, or `false` |

## Tests

`pnpm test` — 38 offline tests over an in-memory Aave market (an EIP-1193
provider that decodes calldata: Pool, oracle, gateway, tokens, Multicall3,
reverts in both dialects) plus the conformance suite. `pnpm verify:live` reads
the Ethereum Core market through a public RPC: market discovery, reserves,
prices, APYs, and proves a supply plan with `eth_call`.

## Status

2026-10-10: built, offline tests green, live read-only verification against
Ethereum mainnet. No funded transaction through the module yet.

## Activity

`describeActivity(tx, { own })` labels the module's own transactions for a wallet's history, offline and synchronously:

- **Recognized**: a call whose target is a known Aave v3 **Pool** or **WrappedTokenGatewayV3** — every preset market on the transaction's chain (`AAVE_MARKETS`) plus the market the instance was configured with. The 4-byte selector picks the kind: `supply` / `supplyWithPermit` / `deposit` and `depositETH` → `supply`; `withdraw` / `withdrawETH` → `withdraw`; `borrow` / `borrowETH` → `borrow`; `repay` / `repayWithPermit` / `repayWithATokens` / `repayETH` → `repay`; `setUserUseReserveAsCollateral` / `setUserEMode` → `contract`. Any other method on an Aave contract is still returned as `contract` ("Aave v3 transaction").
- **Title** is `"<Verb> <asset>"` ("Supplied ETH", "Withdrew USDC"): the principal asset is the `address asset` argument when calldata is present, else the token that moved in the action's direction; the symbol comes from the source's transfer metadata. **Subtitle** is `"Aave v3 · <chain>"`, `counterparty` the contract called, `protocol` the package name.
- **Assets**: `assetsIn` / `assetsOut` are the wallet's net token movements from the receipt (aToken mints and burns included, so a supply shows the aToken arriving).
- **Null** for everything else: another protocol, a plain transfer, a chain without a market.

Fixtures in `fixtures/activity/` are the test wallet's funded Base run (`depositETH` / `withdrawETH`, 2026-10-10) and run through the conformance suite's activity half; `fixtures/activity/negatives/` holds look-alikes that must yield null.

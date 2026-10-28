# @anywalletkit/protocol-lending-mellow-evm

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-lending-mellow-evm?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-lending-mellow-evm)

A simple package that lets `@anywalletkit/wallet-evm` wallet accounts use
[Mellow](https://mellow.finance) **Core Vaults** — Lido's Earn vaults
([EarnETH, EarnUSD, stRATEGY](https://stake.lido.fi/earn)) and any other vault
on the same contracts: supply through the vault's synchronous or asynchronous
deposit queue, redeem and claim through the redeem queue, read the position,
fees, oracle reports and APY.

## Install

```sh
npm install @anywalletkit/protocol-lending-mellow-evm @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-lending-mellow-evm @anywalletkit/core  ·  yarn add @anywalletkit/protocol-lending-mellow-evm @anywalletkit/core
```

On npm: [@anywalletkit/protocol-lending-mellow-evm](https://www.npmjs.com/package/@anywalletkit/protocol-lending-mellow-evm), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

Built on the `LendingProtocol` type in `@anywalletkit/core`, the way the Morpho
module expresses ERC-4626 vaults: `supply` puts an asset into the vault, `withdraw`
takes it out. Mellow's withdrawal is two-phase (request → oracle report →
claim), so the module adds `getWithdrawalRequests` / `claimWithdrawals` on
top; `borrow` / `repay` reject — a vault does not lend.

The mechanics are extracted from a production wallet (React Native/Hermes)
where deposit (sync and async), cancel, claim-shares, redeem and claim were
exercised with real funds on EarnETH and EarnUSD through the direct port this
module was lifted from. Verification status of the module itself
(2026-09-07): 12 offline tests; `verify:live` discovers both Lido vaults
on-chain and finds exactly the queue addresses that production wallet had
hard-coded, and proves the supply / redeem plans with `eth_call`. The
wallet now runs on the module; a funded cycle through it is the next step.

## What a Mellow Core Vault is

A Core Vault holds LP money that a **curator** allocates across DeFi (Aave,
Uniswap, Pendle, Morpho, …) through sub-vaults whose calls are restricted by
an on-chain verifier. LPs hold vault **shares** (`earnETH`, `earnUSD`, …),
priced by the vault's **oracle** once per report (Lido's vaults: at most every
20 hours). Money moves through per-asset **queues** the vault lists itself:

- **Deposit, synchronous queue** — shares are minted in the same transaction
  at the latest report's price; reverts when the report is stale. The module
  tries it first (`instant: true`) after proving the call with `eth_call`.
- **Deposit, asynchronous queue** — one open request per account, priced by
  the next report at least `depositInterval` after it (1 h on Lido's vaults).
  Once priced, the shares count in the balance without any action;
  `claimShares` only moves them physically. Cancellable until priced.
- **Redeem queue** — `redeem(shares)` burns shares at once; the request is
  *not* cancellable; the next report at least `redeemInterval` later (1–2
  days on Lido's vaults) prices it, the curator pulls liquidity, then `claim`
  pays the asset. Lido quotes "instant to ~72 h".

Fees (in shares, read from the vault's FeeManager): deposit, redeem,
performance and a yearly protocol fee. Lido EarnETH today: 15 % performance,
0.2 %/yr protocol, no deposit / redeem fee.

Nothing is configured by hand for a preset: the vault reports its share manager,
oracle, fee manager, assets and queues on-chain, and the module classifies each
queue by the methods it answers (an async deposit queue has `requestOf`, a
redeem queue has `requestsOf`; signature-based queues are skipped). Money only
goes to a queue the package pins, though: the preset's shipped `queues`
(re-checked against the chain on 2026-10-28). The RPC's `queueAt` picks among
them and is never the authority — a user-added or tampered RPC naming its own
queue is refused before any approval. A custom `vault` takes the expected
queue addresses in `queues: {deposit, redeem}`, and the same option admits a
queue Mellow adds before the package catches up.

## Usage

```js
import WalletManagerEvm from '@anywalletkit/wallet-evm'
import MellowProtocolEvm from '@anywalletkit/protocol-lending-mellow-evm'

const wallet = new WalletManagerEvm(seed, { provider: 'https://ethereum-rpc.publicnode.com' })
const account = await wallet.getAccount(0)

const earnUsd = new MellowProtocolEvm(account, { preset: 'lido-earn-usd' }) // or { vault: '0x…' }

// What the vault is: components, assets and queues (discovered on-chain), fees, oracle parameters
const vault = await earnUsd.getVaultData()

// Supply 100 USDT — approve (awaited) + deposit; sync queue when it can mint at once, else the async request
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const { fee, sharesOut, instant } = await earnUsd.quoteSupply({ token: USDT, amount: 100_000_000n })
const { hash } = await earnUsd.supply({ token: USDT, amount: 100_000_000n })

// Position: shares, value at the latest report, what sits in the queues
const position = await earnUsd.getPosition({ token: USDT })

// Withdraw half — amount is in SHARES; the request burns them now, the payout comes after the next report
await earnUsd.withdraw({ token: USDT, amount: position.shares / 2n })

// Later: what is claimable, then claim (one transaction per payout asset)
const { requests, claimable } = await earnUsd.getWithdrawalRequests()
if (claimable.length) await earnUsd.claimWithdrawals({ token: USDT })

// Decoration
await earnUsd.getApr()     // percent, from Mellow's registry
await earnUsd.getStats()   // { apy, tvlUsd, withdrawAvgSeconds }
```

Presets: `lido-earn-eth`, `lido-earn-usd`, and — gated by a deposit
whitelist at the time of writing — `lido-strategy`,
`lido-conservative-earn-usd`, `lido-experimental-earn-usd` (see `note` on
each entry of `MELLOW_ADDRESS_MAP`). Native ETH is `token: 'native'`
(EarnETH). A read-only account
(`{ getAddress }`) is enough for every view; writes need an account with
`sendTransaction({ to, data, value })`.

### Configuration

```js
new MellowProtocolEvm(account, {
  vault: '0x6a37…249e',        // any Core Vault; or preset: 'lido-earn-eth' | 'lido-earn-usd'
  provider: eip1193OrUrl,      // default: the account's provider
  instant: true,               // sync deposit queue first, async fallback
  referral: '0x…',             // forwarded to the deposit queues
  registry: 'https://api.mellow.finance/v1/vaults' | null, // APY / TVL / withdrawal time — decoration only
  maxRedeemRequests: 50
})
```

## Fail-closed rules

- a queue is used only after the vault confirms it (`hasQueue`), its
  direction (`isDepositQueue`) and that it is not paused — right before the
  transaction, not from a cached list;
- a suspicious oracle report (deviation above the vault's threshold) refuses
  supply and withdraw quotes instead of pricing blindly;
- a vault with a deposit whitelist, minting or burning paused is refused;
- a second async deposit request is refused while one is open (the contract
  would revert anyway; the module says why);
- the sync deposit is proven with `eth_call` before it is sent — and proven
  again after an approval was mined, falling back to the async queue if the
  report went stale in between;
- Ethereum's USDT gets its allowance reset to zero before a raise;
- `withdraw` amounts are shares, the only unit known before the report; the
  quoted payout is an estimate at the latest report, after the redeem fee.

## Build and tests

TypeScript, built with `tsup` to `dist/` (ESM + CJS + types); one runtime
dependency (viem) for the RPC client and ABI coding.

```
npm run build          # tsup → dist/
npm test               # vitest: unit tests over a stubbed EIP-1193 provider (selectors of the real contracts) + conformance
npm run verify:live    # on-chain discovery vs. the known Lido deployments, position reads, eth_call proofs — no keys
```

## License

Apache-2.0

## Activity

`describeActivity(tx, { own })` labels Mellow transactions for a wallet's history, offline and synchronously. Deposits and redemptions are calls on a vault's **queues** (DepositQueue / RedeemQueue), which the module normally discovers on-chain, so the offline rule is: the selector is a queue method — `deposit(uint224,address,bytes32[])` → `supply` "Deposited <asset>", `cancelDepositRequest()` → `withdraw` "Cancelled deposit of <asset>", DepositQueue `claim(address)` → `claim` "Claimed <shares>", `redeem(uint256)` → `withdraw` "Requested withdrawal of <shares>", RedeemQueue `claim(address,uint32[])` → `claim` "Claimed <asset>" — **and** either the called contract is a queue a preset listed when it was last verified (`MELLOW_ADDRESS_MAP[1][key].queues`, read on 2026-10-14) or the receipt touches a known vault / share token (a preset's `vault` / `shareManager`, or the vault this instance targets). Writes never use the recorded queues; they are for recognizing history only. Subtitle `"Mellow · Ethereum"`, `counterparty` the queue; `assetsIn` / `assetsOut` are the wallet's net movements with preset share tokens labelled (earnETH, earnUSD, …).

Fixtures in `fixtures/activity/` are the test wallet's funded runs (EarnETH deposit ETH + claim shares, EarnUSD deposit USDT, redeem, claim, cancelDepositRequest; 2026-09-01 … 09-11); `negatives/` holds a Lido submit and an SSV stake.

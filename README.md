# Any Wallet Kit

Open-source multichain wallet SDK. One seed phrase → accounts on EVM (30 networks),
Bitcoin, TON, Tron, Solana, NEAR and Zcash (transparent), with a single account interface that protocol
modules (swap, cross-chain swap, lending, staking, approvals, fiat) are written against.

> **Status: pre-1.0.** Versions are `0.x`: minor releases may still change the
> API. Packages: **[npmjs.com/org/anywalletkit](https://www.npmjs.com/org/anywalletkit)**, published with provenance. Documentation: **[docs.anywallet.tech](https://docs.anywallet.tech)**.

## Install

Every package is on npm under [`@anywalletkit`](https://www.npmjs.com/org/anywalletkit), published
from the [release workflow](RELEASING.md) with [provenance](https://docs.npmjs.com/generating-provenance-statements)
(`npm audit signatures` verifies it). Install only what you use:

```sh
npm install @anywalletkit/kit @anywalletkit/wallet-evm   # plus the chains and modules you need
# or: pnpm add …  ·  yarn add …
```

[![npm](https://img.shields.io/npm/v/@anywalletkit/core?label=%40anywalletkit%2Fcore)](https://www.npmjs.com/package/@anywalletkit/core)
[![npm](https://img.shields.io/npm/v/@anywalletkit/kit?label=%40anywalletkit%2Fkit)](https://www.npmjs.com/package/@anywalletkit/kit)

Building with an AI coding agent? Point it at [AGENTS.md](AGENTS.md) and the
[Build with AI](https://docs.anywallet.tech/build-with-ai/) prompts.

## Why another wallet SDK

- **Conformance is the gate.** Every chain and protocol module passes shared
  suites (`@anywalletkit/conformance`): derivation against pinned vectors, a
  read-only account never writes, a quote never sends, a swap plan pays only
  declared recipients. Modules are listed in a registry with tiers
  (`core` / `verified` / `community`).
- **Signer is separate from the account.** The private key lives in a `Signer`.
  The local seed signer is one implementation; a Safe, a hardware wallet, MPC or
  a backend signer are others. The SDK never *requires* a seed.
- **Built for mobile apps.** React Native / Hermes is the primary target and the
  release gate (`pnpm test:hermes` runs every chain in the real Hermes VM); Node is
  where the suites run. Chain and protocol packages are pure TypeScript: no Bare, no native
  modules, no polyfill magic. Native code lives only in the optional storage packages
  (`secure-storage-react-native`, `backup-cloud`).
  Browsers are out of scope for now (that track returns with an embedded,
  semi-custodial wallet kit later).
- **Standard derivation per chain.** Account `i` is the address MetaMask / Rabby
  (EVM), Phantom (Solana), Trust Wallet (TON), TronLink, BIP-84 wallets (Bitcoin)
  and MyNearWallet derive from the same seed — the table is in
  `@anywalletkit/keyring`, the pinned vectors in `packages/conformance/vectors`.
  Each chain uses the best stack for it.
- **Zeroize by design.** Everything that holds a key has `dispose()`. A manager
  keeps the 64-byte seed, never the phrase (a JS string cannot be zeroized, a
  `Uint8Array` can); the keyring reads a secret per call and disposes the
  account after it.

## Packages

| Package | What |
|---|---|
| `@anywalletkit/core` | Signer / account interfaces, protocol base classes, errors, BIP-39 + BIP-32 / SLIP-10 helpers |
| `@anywalletkit/conformance` | Golden vectors + `describeChainModule` / `describeProtocolModule` test suites |
| `@anywalletkit/wallet-evm` | viem; m/44'/60'/0'/0/i; EIP-191 / EIP-712 / EIP-1559 (+ legacy, 2930, 7702 shapes); ERC-20 transfer + approve; signatures pinned byte-for-byte by golden vectors |
| `@anywalletkit/wallet-solana` | @solana/kit; SLIP-10 m/44'/501'/i'/0'; SOL + SPL transfers with ATA creation; noble ed25519 signing (no WebCrypto); failover RPC |
| `@anywalletkit/runtime-hermes` | one-call React Native polyfills: AbortSignal.timeout/any, subtle.digest, structuredClone + checks for getRandomValues / TextEncoder |
| `@anywalletkit/wallet-ton` | @ton/ton; SLIP-10 m/44'/607'/i' on WalletContractV5R1; TON + jetton transfers; noble ed25519 via the `signer` callback; toncenter failover; receipts via toncenter v3 body hash |
| `@anywalletkit/wallet-tron` | full-node HTTP API, no tronweb; m/44'/195'/0'/0/i; TRX + TRC-20; TIP-191 sign; fee model = bandwidth / energy / activation |
| `@anywalletkit/wallet-near` | JSON-RPC, hand-written borsh (byte-checked vs @near-js); SLIP-10 m/44'/397'/i' (NEAR Wallet path); implicit + named accounts; NEAR + NEP-141 (auto storage_deposit); NEP-413; preflight instead of simulation; dangerous-action guard |
| `@anywalletkit/wallet-btc` | @scure/btc-signer; BIP-84 p2wpkh m/84'/0'/0'/0/i and BIP-86 taproot accounts; own coin selection; RBF; BIP-137 sign; Blockbook / Esplora transports with failover |
| `@anywalletkit/wallet-zcash` | transparent t1… accounts m/44'/133'/0'/0/i; v5 transactions with ZIP-244 txid/sighash (pinned by mined mainnet txs), ZIP-317 fees, ZIP-203 expiry; Blockchair / Blockbook transports; shielded pools out of scope |
| `@anywalletkit/tokens` | tokens users add by address, at their own risk: `inspectToken` reads decimals, symbol, name, supply and issuer powers from the chain (`getTokenInfo` in `wallet-evm` / `wallet-solana`, Token-2022 extensions included) and `assessToken` warns (look-alikes of catalog tokens with Cyrillic / `$` / `₮` / invisible characters folded, permanent delegate, transfer hook, upgradeable proxy…); `TokensTable` keeps the list over any JSON storage; swap them with `allowUnlistedTokens` on the engine |
| `@anywalletkit/networks` | networks for every build: catalog mainnets with the public RPC failover lists (shared by the app and the extension), default testnets per family (off until enabled), `NetworksTable` over any JSON storage (user RPCs prepended, builtins undeletable, `onlyOwnRpc`, parked RPCs), `verifyNetwork` per family (chain id / genesis / TON global id must match, latency + tip), https-only URL policy with the local-http opt-in, EIP-3085 `parseAddChainParams` |
| `@anywalletkit/protocol-swap2-core` | swap2 engine: `BaseSwap2Protocol` / `SingleProviderSwap2` over `Swap2Protocol` from core, `CrossChainRouter`, remote provider, quote/execution safety rails |
| `@anywalletkit/protocol-swap2-router` | `RouterSwap2Protocol`: auctions every engine provider and any external swap2 module, executes the winner, resumes status |
| `@anywalletkit/protocol-swap2-near-intents`, `-lifi`, `-thorchain`, `-omniston` | the four providers (NEAR Intents 1Click, LI.FI REST, THORChain, STON.fi Omniston), each also a standalone `Swap2Protocol` |
| `@anywalletkit/swap2-assets` | CAIP-19 asset registry shared by the swap2 packages |
| `@anywalletkit/protocol-swap2-cctp` | Circle CCTP V2: native USDC burn-and-mint between 17 EVM chains, Fast / Standard by Circle's fee API, two-phase delivery (`claimSwap2` with the user's `receiveMessage`), preflight against the real contracts |
| `@anywalletkit/protocol-swap2-usdt0` | USDT0 (Tether's LayerZero OFT): USDT / USDT0 between 16 EVM chains in one source transaction — `quoteOFT` + `quoteSend` on the OFT itself, `send` with the LayerZero fee as `msg.value`, approval only for the Ethereum adapter, status from LayerZero Scan, `lzReceive` retry of a stored payload as the claim; the only direct USDT path into HyperEVM; every deployment re-verified on-chain |
| `@anywalletkit/protocol-swap2-uniswap` | Uniswap v3 straight from the contracts on 7 chains: QuoterV2 quotes (every fee tier + two-hop via WETH/USDC/USDT in one RPC batch), SwapRouter02 `multicall` execution with deadline, native in/out (wrap via value, `unwrapWETH9`), exact approvals, deployment re-verified on-chain; no API key, no frontend — the permissionless same-chain venue |
| `@anywalletkit/protocol-swap2-wrap` | native ↔ wrapped native (ETH↔WETH, BNB↔WBNB, POL↔WPOL, AVAX↔WAVAX, HYPE↔WHYPE… 16 EVM chains) as a same-chain swap2 venue: WETH9 `deposit()` / `withdraw()`, 1:1, no approval, sender-only, tokens verified on-chain; wrapped natives added to the asset catalog |
| `@anywalletkit/protocol-swap2-balancer` | Balancer v2 same-chain swaps on 9 chains (the cp0x permissionless Balancer venue): the SOR API only suggests the path; the Vault prices it on-chain (`queryBatchSwap`) and `batchSwap` enforces `limits` + deadline; split and multi-hop paths, native via the Vault's ETH sentinel, preflight re-price |
| `@anywalletkit/protocol-swap2-fynd` | Fynd (Propeller Heads) same-chain swaps on Ethereum, Base, Arbitrum, BNB Chain, Polygon, Unichain and Robinhood Chain: routes over the pools Tycho indexes, settled through TychoRouterV3; router, method, tokens, amount, receiver and minimum are decoded and checked before signing. Fynd outputs are under the Fynd License (see the package README) |
| `@anywalletkit/protocol-swap2-jupiter` | Jupiter same-chain Solana swaps through Swap API V2's Router path (`/build`, Metis routing, no Jupiter fee, keyless or `x-api-key`): every instruction vetted and the swap arguments decoded (amount, quoted out, slippage, zero platform fee) before the v0 transaction is assembled locally; compute budget re-set (simulated limit, capped price); the wallet's serialized guard proves programs and balances before signing |
| `@anywalletkit/kit` | orchestrator: register chain wallets + protocol modules, accounts by CAIP-2 chain, policies (fee cap, allow/block lists, confirm) on every write — sends, transfers, `signTransaction`, message signatures; the activity feed (`history()`) |
| `@anywalletkit/keyring` | many accounts from one seed plus imported seeds / private keys / Tonkeeper words, one `AccountMeta` list across chains, per-execution accounts that dispose the key after use |
| `@anywalletkit/tx-preview-evm` | pre-sign review for EVM: decode (recipient, approvals, contract), simulate balance changes at a pinned block, verdict + refusal reasons for the review sheet |
| `@anywalletkit/protocol-staking-lido-evm`, `-ssv-evm`, `-tonstakers-ton`, `-spl-stake-pool-solana` | `StakingProtocol` modules (two-phase withdrawals): Lido, SSV Network, Tonstakers, Jito / SPL stake pools; the EVM two on viem (ported off ethers 2026-10-15) |
| `@anywalletkit/protocol-staking-native-solana` | native SOL staking through the Stake program to the validators the app lists (fail-closed: no list, no module; commission cap and delinquency checked at every delegation); seed-derived stake accounts only the wallet signs, statuses computed from StakeHistory like the program, partial unstake by split, claim, re-delegate, merge |
| `@anywalletkit/protocol-staking-native-monad` | native MON staking through Monad's staking precompile to the validator ids the app lists (fail-closed: no list, no module; live commission cap and active-set check at every delegation); withdrawal slots, claim / compound rewards, Monad's 10 MON reserve respected, every write simulated first |
| `@anywalletkit/protocol-lending-mellow-evm` | Mellow Core Vaults (Lido EarnETH / EarnUSD) as a `LendingProtocol`; viem |
| `@anywalletkit/protocol-lending-aave-evm` | Aave v3 on 18 chains (20 markets) as a `LendingProtocol`: supply / withdraw / borrow / repay, gateway for native, EIP-2612 permits, health factor, reserves with rates and caps; Pool cross-checked against the PoolAddressesProvider |
| `@anywalletkit/protocol-lending-morpho-evm` | Morpho on 10 chains: Vaults (MetaMorpho V1 / Vault V2, ERC-4626) and Blue markets (supply / withdraw / borrow / repay / collateral) as `LendingProtocol`s; vaults verified against the factories, state accrued like the contract, API for listing / APY only |
| `@anywalletkit/protocol-lending-kamino-solana` | Kamino on Solana: Earn vaults (kVaults: deposit / withdraw, shares, APY) and Lend markets (supply / withdraw / borrow / repay on the wallet's obligation) as `LendingProtocol`s; Kamino's official API builds the transaction, the wallet's serialized guard proves programs and balance effects before signing; positions / rates from the API |
| `@anywalletkit/protocol-approvals-evm` | token-approval discovery (ERC-20 / 721 / 1155 / Permit2 / EIP-7702), risk flags, revoke; viem |
| `@anywalletkit/extension-kit` | Chromium (MV3) wallet-extension core: scrypt vault with passkey (PRF) unlock, auto-locking session, dApp request router + per-origin permissions + approval queue, signing checks (SIWE, EIP-7702, address poisoning, phishing list), swap / Earn plan review, TON Connect data, chrome adapters; no UI — the extension itself is the wallet's own product |

Every protocol module ships a `module.json`; `pnpm registry` builds
[registry/modules.json](registry/modules.json) from them (25 modules today). See
[registry/README.md](registry/README.md) for tiers and how to list an external module.

User documentation: [docs.anywallet.tech](https://docs.anywallet.tech) (sources in `apps/docs`).

## Build with AI

Coding agents (Claude Code, Cursor, Codex…) get a compact, exact SDK reference in
[AGENTS.md](AGENTS.md) and the guides as plain text at
[docs.anywallet.tech/llms-small.txt](https://docs.anywallet.tech/llms-small.txt). Copy-paste
prompts that build a wallet, swaps, a review sheet, Earn, accounts, a payout bot or your own
module are in [prompts/](prompts/), with the eval results of each one; the
[Build with AI](https://docs.anywallet.tech/build-with-ai/) docs section explains them.

## Planned modules

Tracked on the SDK board; each lands as its own package behind the conformance gate.

| Area | Next | Later |
|---|---|---|
| Swap & bridge | 0x Swap API v2, Symbiosis, Jupiter `/order` + `/execute` (USDT0 + Chainflip shipped 2026-10-20, Jupiter `/build` 2026-10-23) | rhino.fi, swapdk, BOB Gateway, Velora, Orchestra; Uniswap v4 / v2 + LP positions; Balancer v3 |
| Earn | Sky (sUSDS / SKY), Ethena (USDe → sUSDe), Euler v2, Morpho fixed-rate markets (native SOL staking shipped 2026-10-26) | Hyperliquid exit, fiat on/off-ramp (MoonPay, Transak) |
| Safety | `@anywalletkit/receive` (quarantine receive addresses on a separate seed branch) + `@anywalletkit/screening` (risk signals from shipped lists + on-device 2-hop tracing, two privacy modes); outbound recipient check + address-poisoning detector | tx-preview for Solana / TON / Tron; wallet-btc PSBT partial signing + BIP-322 |
| Accounts | multisig: Safe (EVM), Squads (Solana), multisig-v2 (TON), account permissions (Tron), multisig2 / Sputnik (NEAR) | gasless sends (EIP-7702 + paymaster, GasFree on Tron, TON paymaster, Solana fee payer) |
| Names | ENS, SNS `.sol`, TON DNS `.ton`, NEAR named accounts on one `NameResolver` | `.gwei` |
| Chains | — | Cosmos / IBC, Polkadot / Asset Hub |

## Tests

`pnpm test` runs 2,700+ tests across 47 packages (Node); `pnpm test:hermes` runs 333
checks in the Hermes VM React Native ships. Beyond unit tests the swap layer is
checked against live providers (running totals, October 2026): 127,168 quote checks
(11 providers, up to 36 chains, 378 assets), 60,013 builds simulated to the
signature, 24,155 router auctions with the ranking invariants (best = max net
value, fastest = min ETA) and 562 real-money swaps; every Earn module has a
read-only `verify:live` across all its markets, and every module ships recorded
real transactions its `describeActivity` must recognize.

## Develop

```sh
pnpm install
pnpm build
pnpm test            # Node: every suite
pnpm test:hermes     # the Hermes VM React Native ships: derive + sign on every chain vs the golden vectors, protocol modules load and quote-guard
```

A package is not green until Node AND Hermes are.

Every package is TypeScript built with tsup (ESM + CJS + `.d.ts`), and the EVM
packages share one library, viem — there is no ethers in the tree. Two modules
are still plain ESM with hand-written types and will be converted next:
`protocol-staking-tonstakers-ton` and `protocol-staking-spl-stake-pool-solana`.

## Versions and releases

Versions move only through [changesets](.changeset): every change that touches a
package's behaviour adds one (`pnpm changeset`), and a release applies them
(`pnpm changeset version` → bumped `package.json`s + `CHANGELOG.md`s). Publishing
runs only in the `release` workflow, with npm provenance — see
[RELEASING.md](RELEASING.md).

For contributors: a build of an unreleased branch can be taken as tarballs:

```sh
node scripts/vendor.mjs --out ../app/vendor/anywalletkit --consumer ../app/package.json
```

builds every package, stamps each `package.json` with
`anywalletkit: { commit, branch, builtAt, dirty }`, packs versioned tarballs,
writes `manifest.json` next to them and repoints the consumer's `file:`
references — so an app can always say which SDK commit it runs (`dirty` means
the tree had uncommitted changes under `packages/` and the build is not
reproducible from `commit` alone).

## Contributing and security

Outside pull requests are not accepted yet — issues are welcome
([CONTRIBUTING.md](CONTRIBUTING.md)). Report vulnerabilities privately:
[SECURITY.md](SECURITY.md).

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

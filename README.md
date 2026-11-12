# Any Wallet Kit

Open-source multichain wallet SDK. One seed phrase → accounts on EVM (31 networks),
Bitcoin, TON, Tron, Solana, NEAR and Zcash (transparent), with a single account interface that protocol
modules (swap, cross-chain swap, lending, staking, approvals, names) are written against.

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
  read-only account never writes, a quote never sends, a swap plan calls only
  declared contracts and pays only declared recipients (router calldata
  included, as the module's test decodes it). Modules are listed in a registry with tiers
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
| `@anywalletkit/protocol-swap2-usdt0` | USDT0 (the LayerZero OFT for USDT): USDT / USDT0 between 16 EVM chains, and USDT from Ethereum / Arbitrum / Celo into Tron and TON through the USDT0 Legacy Mesh, in one source transaction — `quoteOFT` + `quoteSend` on the OFT itself, `send` with the LayerZero fee as `msg.value`, approval only for the Ethereum adapter, status from LayerZero Scan, `lzReceive` retry of a stored payload as the claim; the only direct USDT path into HyperEVM; every deployment re-verified on-chain |
| `@anywalletkit/protocol-swap2-chainflip` | Chainflip vault swaps: native BTC / ETH / SOL / TRX and USDC / USDT across Ethereum, Arbitrum, Solana, Tron and Bitcoin through Chainflip's public backend (its own broker, 0 bps, no account); sources Ethereum, Arbitrum and Tron (Tron: a plain USDT transfer to the Vault with the swap in the note — no approval); every byte the encoder returns decoded and checked before signing; fill-or-kill refunds to the sender |
| `@anywalletkit/protocol-swap2-symbiosis` | Symbiosis cross-chain swaps through its public REST API (no key, no partner id, 0 bps of ours): Ethereum, BNB Chain, Avalanche, Polygon, Arbitrum, Optimism and Base plus TON as sources, Tron as an opt-in source, all nine as destinations; one transaction to the pinned MetaRouterGateway (or one jetton transfer to the pinned TON portal) with the calldata decoded and bound to the request — pools, path, destination call, recipient, minimum — before a quote is shown; routes whose calldata cannot be read are refused; limits enforced locally; stuck / reverted states reported as they are |
| `@anywalletkit/protocol-swap2-uniswap` | Uniswap v3 straight from the contracts on 16 chains: QuoterV2 quotes (every fee tier + two-hop via WETH/USDC/USDT/USDT0 in one RPC batch; a pool too shallow for the input — a partial fill at the price bound — or a minimum that rounds to 0 is refused by name), SwapRouter02 `multicall` execution with deadline, native in/out (wrap via value, `unwrapWETH9`), exact approvals, deployment re-verified on-chain; no API key, no frontend — the permissionless same-chain venue |
| `@anywalletkit/protocol-swap2-wrap` | native ↔ wrapped native (ETH↔WETH, BNB↔WBNB, POL↔WPOL, AVAX↔WAVAX, HYPE↔WHYPE… 28 EVM chains) as a same-chain swap2 venue: WETH9 `deposit()` / `withdraw()`, 1:1, no approval, sender-only, tokens verified on-chain; wrapped natives added to the asset catalog |
| `@anywalletkit/protocol-swap2-balancer` | Balancer v2 same-chain swaps on 9 chains (the cp0x permissionless Balancer venue): the SOR API only suggests the path; the Vault prices it on-chain (`queryBatchSwap`) and `batchSwap` enforces `limits` + deadline; split and multi-hop paths, native via the Vault's ETH sentinel, preflight re-price |
| `@anywalletkit/protocol-swap2-curve` | Curve same-chain swaps straight from the contracts on Router NG (18 EVM chains pinned; pools today on Ethereum, Arbitrum, Base, OP Mainnet, Gnosis, Monad, Plasma and X Layer): the router's `get_dy` quotes and explicit-receiver `exchange`, 1–2 pools per route from a curated allowlist generated and checked on-chain (code hash, coins, TVL, age) and pinned in the package, hops between pools only through catalog tokens, fake / drained pools denied; router code hash and version checked once per chain, preflight re-reads pools and a fresh `get_dy`, a remote build's minimum held to the device's own `get_dy`; no API, no key, no fee |
| `@anywalletkit/protocol-swap2-fynd` | Fynd (Propeller Heads) same-chain swaps on Ethereum, Base, Arbitrum, BNB Chain, Polygon, Unichain and Robinhood Chain: routes over the pools Tycho indexes, settled through TychoRouterV3; router, method, tokens, amount, receiver and minimum are decoded and checked before signing. Fynd outputs are under the Fynd License (see the package README) |
| `@anywalletkit/protocol-swap2-relay` | Relay (relay.link) EVM → EVM bridging and cross-chain swaps through the RelayDepository on 29 pinned chains, quoted from Relay's own API and verified on the device: the order behind the deposit id is hashed here (EIP-712 `hashStruct`) and held to the calldata, the solver's signature must recover to the pinned signer, recipient, chains, tokens, amounts, minimum, deadlines and every refund recipient are held to the request, and the deposit and the exact approval are built locally for the pinned depository; named refusals, no provider SDK, no key |
| `@anywalletkit/protocol-swap2-jupiter` | Jupiter same-chain Solana swaps through Swap API V2's Router path (`/build`, Metis routing, no Jupiter fee, keyless or `x-api-key`): every instruction vetted and the swap arguments decoded (amount, quoted out, slippage, zero platform fee) before the v0 transaction is assembled locally; compute budget re-set (simulated limit, capped price); the wallet's serialized guard proves programs and balances before signing |
| `@anywalletkit/kit` | orchestrator: register chain wallets + protocol modules, accounts by CAIP-2 chain, policies (fee cap, allow/block lists, confirm) on every write — sends, transfers, `signTransaction`, message signatures; the activity feed (`history()`) |
| `@anywalletkit/keyring` | many accounts from one seed plus imported seeds / private keys / Tonkeeper words, one `AccountMeta` list across chains, per-execution accounts that dispose the key after use |
| `@anywalletkit/names-ens` | ENS names on the core `NameResolver`: `vitalik.eth` / `name.base.eth` / `alice.cb.id` → the address for one chain (ENSIP-9/11 multichain, wildcard + CCIP-Read), verified primary names, avatars, look-alike warnings |
| `@anywalletkit/history-evm` | activity history (`HistorySource`) for every EVM chain the SDK supports: Etherscan v2, Blockscout PRO and Alchemy Transfers (API keys) with Blockscout and Routescan keyless fallbacks, merged into one `ChainTx` per hash with a documented spam heuristic |
| `@anywalletkit/tx-preview-evm` | pre-sign review for EVM: decode (recipient, approvals, contract), simulate balance changes at a pinned block, verdict + refusal reasons for the review sheet |
| `@anywalletkit/protocol-staking-lido-evm`, `-ssv-evm`, `-tonstakers-ton`, `-spl-stake-pool-solana` | `StakingProtocol` modules (two-phase withdrawals): Lido, SSV Network, Tonstakers, Jito / SPL stake pools; the EVM two on viem |
| `@anywalletkit/protocol-staking-native-solana` | native SOL staking through the Stake program to the validators the app lists (fail-closed: no list, no module; commission cap and delinquency checked at every delegation); seed-derived stake accounts only the wallet signs, statuses computed from StakeHistory like the program, partial unstake by split, claim, re-delegate, merge |
| `@anywalletkit/protocol-staking-native-monad` | native MON staking through Monad's staking precompile to the validator ids the app lists (fail-closed: no list, no module; live commission cap and active-set check at every delegation); withdrawal slots, claim / compound rewards, Monad's 10 MON reserve respected, every write simulated first |
| `@anywalletkit/protocol-staking-native-near` | native NEAR staking: `deposit_and_stake` into the staking pools the app lists (fail-closed: no list, no module; factory-suffix check before any RPC call, pinned staking-pool code hashes, live pause, fee cap and validator-set checks at every stake, while exits need only a known pool); 4-epoch unbonding (exact unlock epoch when the app passes the account's `history`, else a range), `withdraw_all` per pool, APR from the protocol's reward data; quotes return the exact NEAR transactions for external signers, and a write refuses when its fresh plan differs from the confirmed one |
| `@anywalletkit/protocol-staking-liquid-near` | liquid NEAR staking through the LiNEAR contract family: LiNEAR and Rhea rNEAR, pinned by account id and code hash (an unpinned upgrade or a paused contract refuses every write); stake for the token, delayed unstake with the contract's exact unlock epoch, withdraw after a contract-liquidity check, APR from the price over time; function calls to the pinned contract only (never `ft_transfer_call`), exact transactions for external signers |
| `@anywalletkit/protocol-lending-mellow-evm` | Mellow Core Vaults (Lido EarnETH / EarnUSD) as a `LendingProtocol`; viem |
| `@anywalletkit/protocol-lending-aave-evm` | Aave v3 on 18 chains (20 markets) as a `LendingProtocol`: supply / withdraw / borrow / repay, gateway for native, EIP-2612 permits, health factor, reserves with rates and caps; Pool cross-checked against the PoolAddressesProvider |
| `@anywalletkit/protocol-lending-morpho-evm` | Morpho on 13 chains: Vaults (MetaMorpho V1 / Vault V2, ERC-4626) and Blue markets (supply / withdraw / borrow / repay / collateral) as `LendingProtocol`s; vaults verified against the factories, state accrued like the contract, API for listing / APY only |
| `@anywalletkit/protocol-lending-kamino-solana` | Kamino on Solana: Earn vaults (kVaults: deposit / withdraw, shares, APY) and Lend markets (supply / withdraw / borrow / repay on the wallet's obligation) as `LendingProtocol`s; Kamino's official API builds the transaction, the wallet's serialized guard proves programs and balance effects before signing; positions / rates from the API |
| `@anywalletkit/protocol-lending-curve-evm` | Curve Savings crvUSD (scrvUSD, a Yearn V3 vault) on Ethereum as a `LendingProtocol`: the vault's clone code, implementation code hash, apiVersion and asset verified before any call, deposits refused into a shut-down vault or one lending to strategies, withdrawals with max_loss 0, APY projected on-chain with the Curve API figure bounded to within max(0.5 pp, 10 %) of it (clamped to that band when it disagrees; the on-chain figure without the API) |
| `@anywalletkit/protocol-approvals-evm` | token-approval discovery (ERC-20 / 721 / 1155 / Permit2 / EIP-7702), risk flags, revoke; viem |
| `@anywalletkit/walletconnect-ton` | WalletConnect for TON (works without a TON wallets-registry listing): the `ton` session namespace with the user-friendly account, the required `ton_getPublicKey` / `ton_getStateInit` session properties, `ton_proof` at connect, `ton_sendMessage` / `ton_signData` parsed by the shared TON Connect parser (`wallet-ton/tonconnect`), reviewed, signed once under the account's policies; no WalletConnect runtime dependency |
| `@anywalletkit/seed-vault` | encrypted backups of wallet secrets: a versioned, self-describing envelope (XChaCha20-Poly1305 under a random data key) that one or more protectors unlock — a password through Argon2id, or a 32-byte key from a passkey PRF, an iCloud Keychain / Block Store item or a hardware key; metadata authenticated, keys zeroized, strict bounded decode; pure TypeScript, Hermes-safe |
| `@anywalletkit/secure-storage-react-native` | device secret storage for React Native (the keyring's `SecretStorage`): iOS Keychain behind a Secure Enclave–checked access control or an Android Keystore key in StrongBox / TEE that needs the user for every read; Face ID or the device passcode by default, opt-in strict biometrics, this device only, never in backups, a named biometry-changed error, verified migration from older stores |
| `@anywalletkit/backup-cloud` | cloud backups for React Native: `seed-vault` files in the app's hidden iCloud Drive container, plus a no-password option whose key lives in iCloud Keychain while the file lives in iCloud Drive (neither alone opens it); fingerprint compared before anything is written; an Expo config plugin adds the entitlements; Android (Google Drive appDataFolder, Block Store) next |
| `@anywalletkit/extension-kit` | Chromium (MV3) wallet-extension core: scrypt vault with passkey (PRF) unlock, auto-locking session, dApp request router + per-origin permissions + approval queue, signing checks (SIWE, EIP-7702, address poisoning, phishing list), swap / Earn plan review, TON Connect data, chrome adapters; no UI — the extension itself is the wallet's own product |

Every protocol module ships a `module.json`; `pnpm registry` builds
[registry/modules.json](registry/modules.json) from them (31 modules today). See
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
| Swap & bridge | 0x Swap API v2, Symbiosis, Jupiter `/order` + `/execute` (USDT0 + Chainflip shipped 2026-10-20, Jupiter `/build` 2026-10-23, Curve 2026-11-07) | rhino.fi, swapdk, BOB Gateway, Velora, Orchestra; Uniswap v4 / v2 + LP positions; Balancer v3 |
| Earn | Sky (sUSDS / SKY), Ethena (USDe → sUSDe), Euler v2, Morpho fixed-rate markets (native SOL + MON staking shipped 2026-10-26, Curve scrvUSD 2026-11-07, native NEAR + LiNEAR / rNEAR staking 2026-11-08) | Hyperliquid exit, fiat on/off-ramp (MoonPay, Transak) |
| Safety | `@anywalletkit/receive` (quarantine receive addresses on a separate seed branch) + `@anywalletkit/screening` (risk signals from shipped lists + on-device 2-hop tracing, two privacy modes); outbound recipient check + address-poisoning detector | tx-preview for Solana / TON / Tron; wallet-btc PSBT partial signing + BIP-322 |
| Accounts | multisig: Safe (EVM), Squads (Solana), multisig-v2 (TON), account permissions (Tron), multisig2 / Sputnik (NEAR) | gasless sends (EIP-7702 + paymaster, GasFree on Tron, TON paymaster, Solana fee payer) |
| Names | SNS `.sol`, TON DNS `.ton`, NEAR named accounts on the same `NameResolver` (ENS shipped) | `.gwei` |
| Chains | — | Cosmos / IBC, Polkadot / Asset Hub |

## Tests

`pnpm test` runs 5,700+ tests across 54 packages (Node); `pnpm test:hermes` runs 418
checks in the Hermes VM React Native ships. Beyond unit tests the swap layer is
checked against live providers (running totals, November 2026): 149,728 quote checks
(13 providers, up to 36 chains, 398 assets), 65,481 builds simulated to the
signature, 26,631 router auctions with the ranking invariants (best = max net
value, fastest = min ETA) and 578 real-money swaps; every Earn module has a
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

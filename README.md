# forgewallet

> Working name. Rename = one `sed` over `@forgewallet/`.

Open-source multichain wallet SDK. One seed phrase → accounts on EVM, Bitcoin,
TON, Tron and Solana, with a single account interface that protocol modules
(swap, cross-chain swap, lending, staking, approvals, fiat) are written against.

**Anyone can contribute a module.** A module is accepted when it passes the
conformance suite and names a maintainer — not when the protocol team itself
shows up. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Why another wallet SDK

- **Open contribution model.** Tests are the gate, not trust. Modules are
  tiered `core` / `verified` / `community`; an unmaintained module becomes
  `deprecated` automatically, it is never silently kept or deleted.
- **Signer is separate from the account.** The private key lives in a `Signer`.
  The local seed signer is one implementation; a Safe, a hardware wallet, MPC or
  a backend signer are others. The SDK never *requires* a seed.
- **Built for mobile apps.** React Native / Hermes is the primary target and the
  release gate (`pnpm test:hermes` runs every chain in the real Hermes VM); Node is
  where the suites run. No Bare, no native modules, no polyfill magic inside packages.
  Browsers are out of scope for now (that track returns with an embedded,
  semi-custodial wallet kit later).
- **Standard derivation.** Wallets on the standard paths resolve the same
  addresses from the same seed, pinned by golden vectors in
  `packages/conformance/vectors`. Migrating costs nothing in user funds.
- **Zeroize by design.** Everything that holds a key has `dispose()`.

## Packages

| Package | Status | What |
|---|---|---|
| `@forgewallet/core` | phase 0 | Signer / account interfaces, protocol base classes, errors, BIP-39 + BIP-32 / SLIP-10 helpers |
| `@forgewallet/conformance` | phase 0 | Golden vectors + `describeChainModule` / `describeProtocolModule` test suites |
| `@forgewallet/wallet-evm` | phase 1 ✓ | viem; m/44'/60'/0'/0/i; EIP-191 / EIP-712 / EIP-1559 (+ legacy, 2930, 7702 shapes); ERC-20 transfer + approve; byte-for-byte signature vectors |
| `@forgewallet/wallet-solana` | phase 1 ✓ | @solana/kit; SLIP-10 m/44'/501'/i'/0'; SOL + SPL transfers with ATA creation; noble ed25519 signing (no WebCrypto); failover RPC |
| `@forgewallet/runtime-hermes` | phase 1 ✓ | one-call React Native polyfills: AbortSignal.timeout/any, subtle.digest, structuredClone + checks for getRandomValues / TextEncoder |
| `@forgewallet/wallet-ton` | phase 2 ✓ | @ton/ton; SLIP-10 m/44'/607'/i' on WalletContractV5R1; TON + jetton transfers; noble ed25519 via the `signer` callback; toncenter failover; receipts via toncenter v3 body hash |
| `@forgewallet/wallet-tron` | phase 2 ✓ | full-node HTTP API, no tronweb; m/44'/195'/0'/0/i; TRX + TRC-20; TIP-191 sign; fee model (bandwidth/energy/activation) |
| `@forgewallet/wallet-near` | 2026-10-10 ✓ | JSON-RPC, hand-written borsh (byte-checked vs @near-js); SLIP-10 m/44'/397'/i' (NEAR Wallet path); implicit + named accounts; NEAR + NEP-141 (auto storage_deposit); NEP-413; preflight instead of simulation; dangerous-action guard |
| `@forgewallet/wallet-btc` | phase 2 ✓ | bitcoinjs-lib 7; BIP-84 p2wpkh m/84'/0'/0'/0/i; @bitcoinerlab/coinselect with fixed parameters; PSBT signing; BIP-137 sign; Blockbook HTTP client with failover (electrum = extension point) |
| `@forgewallet/protocol-swap2-core` | phase 3 ✓ | swap2 engine: `BaseSwap2Protocol` / `SingleProviderSwap2` over `Swap2Protocol` from core, `CrossChainRouter`, remote provider, quote/execution safety rails |
| `@forgewallet/protocol-swap2-router` | phase 3 ✓ | `RouterSwap2Protocol`: auctions every engine provider and any external swap2 module, executes the winner, resumes status |
| `@forgewallet/protocol-swap2-near-intents`, `-lifi`, `-thorchain`, `-omniston` | phase 3 ✓ | the four providers (NEAR Intents 1Click, LI.FI REST, THORChain, STON.fi Omniston), each also a standalone `Swap2Protocol` |
| `@forgewallet/swap2-assets` | phase 3 ✓ | CAIP-19 asset registry shared by the swap2 packages |
| `@forgewallet/protocol-swap2-cctp` | 2026-10-10 ✓ | Circle CCTP V2: native USDC burn-and-mint between 17 EVM chains, Fast / Standard by Circle's fee API, two-phase delivery (`claimSwap2` with the user's `receiveMessage`), preflight against the real contracts |
| `@forgewallet/protocol-swap2-uniswap` | 2026-10-12 ✓ | Uniswap v3 straight from the contracts on 7 chains: QuoterV2 quotes (every fee tier + two-hop via WETH/USDC/USDT in one RPC batch), SwapRouter02 `multicall` execution with deadline, native in/out (wrap via value, `unwrapWETH9`), exact approvals, deployment re-verified on-chain; no API key, no frontend — the permissionless same-chain venue |
| `@forgewallet/protocol-swap2-wrap` | 2026-10-12 ✓ | native ↔ wrapped native (ETH↔WETH, BNB↔WBNB, POL↔WPOL, AVAX↔WAVAX, HYPE↔WHYPE… 13 EVM chains) as a same-chain swap2 venue: WETH9 `deposit()` / `withdraw()`, 1:1, no approval, sender-only, tokens verified on-chain; wrapped natives added to the asset catalog |
| `@forgewallet/protocol-swap2-balancer` | 2026-10-13 ✓ | Balancer v2 same-chain swaps on 9 chains (the cp0x permissionless Balancer venue): the SOR API only suggests the path; the Vault prices it on-chain (`queryBatchSwap`) and `batchSwap` enforces `limits` + deadline; split and multi-hop paths, native via the Vault's ETH sentinel, preflight re-price |
| `@forgewallet/kit` | phase 3 ✓ | orchestrator: register chain wallets + protocol modules, accounts by CAIP-2 chain, policies (fee cap, allow/block lists, confirm) before every broadcast |
| `@forgewallet/protocol-staking-lido-evm`, `-ssv-evm`, `-tonstakers-ton`, `-spl-stake-pool-solana` | phase 4 ✓ | `StakingProtocol` modules (two-phase withdrawals): Lido, SSV Network, Tonstakers, Jito / SPL stake pools |
| `@forgewallet/protocol-lending-mellow-evm` | phase 4 ✓ | Mellow Core Vaults (Lido EarnETH / EarnUSD) as a `LendingProtocol` |
| `@forgewallet/protocol-lending-aave-evm` | 2026-10-10 ✓ | Aave v3 on 18 chains (20 markets) as a `LendingProtocol`: supply / withdraw / borrow / repay, gateway for native, EIP-2612 permits, health factor, reserves with rates and caps; Pool cross-checked against the PoolAddressesProvider |
| `@forgewallet/protocol-lending-morpho-evm` | 2026-10-10 ✓ | Morpho on 10 chains: Vaults (MetaMorpho V1 / Vault V2, ERC-4626) and Blue markets (supply / withdraw / borrow / repay / collateral) as `LendingProtocol`s; vaults verified against the factories, state accrued like the contract, API for listing / APY only |
| `@forgewallet/protocol-approvals-evm` | phase 4 ✓ | token-approval discovery (ERC-20 / 721 / 1155 / Permit2 / EIP-7702), risk flags, revoke |

Every protocol module ships a `module.json`; `pnpm registry` builds
[registry/modules.json](registry/modules.json) from them (14 modules today). See
[registry/README.md](registry/README.md) for tiers and how to list an external module.


## Develop

```sh
pnpm install
pnpm build
pnpm test            # Node: every suite
pnpm test:hermes     # the Hermes VM React Native ships: derive + sign on every chain vs the golden vectors, protocol modules load and quote-guard
```

A package is not green until Node AND Hermes are.

## License

Apache-2.0.

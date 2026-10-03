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
- **Three runtimes in CI**: browser (web worker), React Native Hermes, Node.
  No Bare, no native modules, no polyfill magic inside packages.
- **Standard derivation.** Wallets on the standard paths resolve the same
  addresses from the same seed, pinned by golden vectors in
  `packages/conformance/vectors`. Migrating costs nothing in user funds.
- **Zeroize by design.** Everything that holds a key has `dispose()`.

## Packages

| Package | Status | What |
|---|---|---|
| `@forgewallet/core` | phase 0 | Signer / account interfaces, protocol base classes, errors, BIP-39 + BIP-32 / SLIP-10 helpers |
| `@forgewallet/conformance` | phase 0 | Golden vectors + `describeChainModule` / `describeProtocolModule` test suites |
| `@forgewallet/wallet-evm` | P0, phase 1 | |
| `@forgewallet/wallet-solana` | P0, phase 1 | |
| `@forgewallet/wallet-ton` | P0, phase 2 | |
| `@forgewallet/wallet-tron` | P0, phase 2 | |
| `@forgewallet/wallet-btc` | P0, phase 2 | |
| `@forgewallet/protocol-swidge-*` | P1, phase 3 | NEAR Intents, LI.FI, THORChain, Omniston behind one router |
| `@forgewallet/protocol-staking-*`, `protocol-lending-*`, `protocol-approvals-*` | P2, phase 4 | Lido, SSV, Tonstakers, Jito / SPL stake pools, Mellow, approvals |


## Develop

```sh
pnpm install
pnpm build
pnpm test
```

## License

Apache-2.0.

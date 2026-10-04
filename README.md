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
| `@forgewallet/wallet-evm` | phase 1 ✓ | viem; m/44'/60'/0'/0/i; EIP-191 / EIP-712 / EIP-1559 (+ legacy, 2930, 7702 shapes); ERC-20 transfer + approve; byte-for-byte signature vectors |
| `@forgewallet/wallet-solana` | phase 1 ✓ | @solana/kit; SLIP-10 m/44'/501'/i'/0'; SOL + SPL transfers with ATA creation; noble ed25519 signing (no WebCrypto); failover RPC |
| `@forgewallet/runtime-hermes` | phase 1 ✓ | one-call React Native polyfills: AbortSignal.timeout/any, subtle.digest, structuredClone + checks for getRandomValues / TextEncoder |
| `@forgewallet/wallet-ton` | phase 2 ✓ | @ton/ton; SLIP-10 m/44'/607'/i' on WalletContractV5R1; TON + jetton transfers; noble ed25519 via the `signer` callback; toncenter failover; receipts via toncenter v3 body hash |
| `@forgewallet/wallet-tron` | phase 2 ✓ | full-node HTTP API, no tronweb; m/44'/195'/0'/0/i; TRX + TRC-20; TIP-191 sign; fee model (bandwidth/energy/activation) |
| `@forgewallet/wallet-btc` | phase 2 ✓ | bitcoinjs-lib 7; BIP-84 p2wpkh m/84'/0'/0'/0/i; @bitcoinerlab/coinselect with fixed parameters; PSBT signing; BIP-137 sign; Blockbook HTTP client with failover (electrum = extension point) |
| `@forgewallet/protocol-swidge-*` | P1, phase 3 | NEAR Intents, LI.FI, THORChain, Omniston behind one router |
| `@forgewallet/protocol-staking-*`, `protocol-lending-*`, `protocol-approvals-*` | P2, phase 4 | Lido, SSV, Tonstakers, Jito / SPL stake pools, Mellow, approvals |


## Develop

```sh
pnpm install
pnpm build
pnpm test            # Node
pnpm test:browser    # Chromium via Playwright (locally: PW_CHANNEL=chrome to use installed Chrome)
pnpm test:hermes     # the Hermes VM React Native ships; derive + sign on every chain vs the golden vectors
```

Three runtimes, one test suite: a package is not green until all three are.

## License

Apache-2.0.

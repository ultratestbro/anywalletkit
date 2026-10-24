# @anywalletkit/core

[![npm](https://img.shields.io/npm/v/@anywalletkit/core?label=npm)](https://www.npmjs.com/package/@anywalletkit/core)

The contracts every Any Wallet Kit package is written against.

- **Accounts and signers.** `IWalletAccount` (what protocol modules see) and `Signer` (what holds a key). The local seed signer is one implementation; a Safe, a hardware wallet, MPC or a backend signer are others.
- **`WalletManager`** — the base class chain packages extend: one seed → accounts by index or path, `dispose()` zeroizes.
- **Protocol base classes** — swap, bridge, swap2 (swap + bridge in one), lending, staking, approvals, fiat. Every method throws `NotImplementedError` until a module implements it.
- **Errors** — the shared error classes apps branch on.
- **Key derivation** — BIP-39 seeds, BIP-32 (secp256k1) and SLIP-10 (ed25519) helpers.
- **History, names, numbers** — the activity and `NameResolver` interfaces, and BigInt helpers that are safe on Hermes.


## Install

```sh
npm install @anywalletkit/core
# or: pnpm add @anywalletkit/core  ·  yarn add @anywalletkit/core
```

On npm: [@anywalletkit/core](https://www.npmjs.com/package/@anywalletkit/core), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

Docs: [Accounts and signers](https://docs.anywallet.tech/concepts/accounts-and-signers/) · [Errors](https://docs.anywallet.tech/concepts/errors/) · [Packages](https://docs.anywallet.tech/getting-started/packages/)

Apache-2.0

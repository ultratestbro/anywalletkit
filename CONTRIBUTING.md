# Contributing

## Adding a protocol module

1. Pick the protocol type: `swap`, `bridge`, `swap2`, `lending`, `staking`,
   `approvals`, `fiat`. If none fits, open an RFC issue first (see below).
2. Create `packages/protocol-<type>-<name>-<chain>` extending the base class
   from `@forgewallet/core`. Write it against `IWalletAccount` only — never
   against a concrete chain package.
3. Add `module.json` (registry manifest) and a test that calls
   `describeProtocolModule()` from `@forgewallet/conformance`.
4. Open a PR with: conformance green, the manifest, a link to one real
   transaction executed through the module, and your handle in `CODEOWNERS`.

Tiers: `community` (conformance passes) → `verified` (review + live tx) →
`core` (maintained by the project). A module whose maintainer is unresponsive
for 6 months is marked `deprecated` in the registry.

## Adding a chain module

Same as above, extending `WalletManager` / `IWalletAccount`, plus
`describeChainModule()` with golden vectors for at least two seeds and two
account indexes. Derivation must be documented (path, curve, address encoding).

## Changing `core`

New protocol type, change to the account interface, new error class: open an
issue with the `rfc` template, 7 days of discussion, then PR.

## Local

```sh
pnpm install && pnpm build && pnpm test
pnpm changeset   # one per user-visible change
```

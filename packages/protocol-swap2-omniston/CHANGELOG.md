# @anywalletkit/protocol-swap2-omniston

## 0.2.8

### Patch Changes

- b1350b4: Every type a public signature uses is exported, so the API reference documents it and apps can name it: the provider config types (`LifiSwap2Config`, `BalancerSwap2Config`, `NearIntentsSwap2Config`, `FyndSwap2Config`, …), the explorer client options in history-evm (`EtherscanClientOptions`, `AlchemyClientOptions`, `BlockscoutClientOptions`), `Swap2ExecutionPhase`, the Omniston client shapes, and the row / view types the chain packages already expose through their methods. Type-only additions, plus the account-meta role constants of native SOL staking (`READONLY`, `WRITABLE`, …). Renames on export: Aave and Morpho activity `Action` → `AaveActivityAction` / `MorphoActivityAction`; conformance `ProtocolCtor` / `WriteProtocolCtor`; history-evm `RawRow`.
- eb14cb5: npm metadata: every package has a description and the `anywalletkit` keyword. The LI.FI, NEAR Intents, Omniston and THORChain packages had an empty description, so npm showed the README badge markdown in its place, and 24 packages were missing from a `keywords:anywalletkit` search. `pnpm pack:check` now refuses a package without either.
- Updated dependencies [b1350b4]
- Updated dependencies [eb14cb5]
  - @anywalletkit/protocol-swap2-core@0.6.1
  - @anywalletkit/core@0.6.1
  - @anywalletkit/swap2-assets@0.2.2

## 0.2.7

### Patch Changes

- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- b55aa5d: TON swap tracking reports a partial fill as `partial` (was `completed`) and a failed or cancelled DEX swap, whose input bounces back to the trader, as `refunded` (was `failed`).
- Updated dependencies [f743c06]
- Updated dependencies [f743c06]
- Updated dependencies [d82e140]
- Updated dependencies [d82e140]
- Updated dependencies [f743c06]
- Updated dependencies [398129f]
- Updated dependencies [b55aa5d]
- Updated dependencies [b55aa5d]
- Updated dependencies [b55aa5d]
- Updated dependencies [b55aa5d]
- Updated dependencies [b55aa5d]
  - @anywalletkit/core@0.6.0
  - @anywalletkit/protocol-swap2-core@0.6.0
  - @anywalletkit/swap2-assets@0.2.1

## 0.2.6

### Patch Changes

- Updated dependencies [6dde4e4]
- Updated dependencies [b08c01a]
- Updated dependencies [e9cc028]
- Updated dependencies [a354990]
- Updated dependencies [0d0e46e]
  - @anywalletkit/swap2-assets@0.2.0
  - @anywalletkit/core@0.5.0
  - @anywalletkit/protocol-swap2-core@0.5.0

## 0.2.5

### Patch Changes

- Updated dependencies [8aa911d]
- Updated dependencies [8aa911d]
- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1
  - @anywalletkit/protocol-swap2-core@0.4.1
  - @anywalletkit/swap2-assets@0.1.5

## 0.2.4

### Patch Changes

- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- Updated dependencies [07db4c1]
- Updated dependencies [80d6451]
- Updated dependencies [a9a5e0a]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
- Updated dependencies [c4dc4d6]
- Updated dependencies [ed99146]
  - @anywalletkit/core@0.4.0
  - @anywalletkit/protocol-swap2-core@0.4.0
  - @anywalletkit/swap2-assets@0.1.5

## 0.2.3

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2
  - @anywalletkit/protocol-swap2-core@0.3.2
  - @anywalletkit/swap2-assets@0.1.4

## 0.2.2

### Patch Changes

- `@ston-fi/omniston-sdk` 0.8.11 → 0.8.12, which brings `ws` 8.22.0 and so clears GHSA-58qx-3vcg-4xpx (uninitialized memory disclosure) and the fragment memory-exhaustion DoS fixed after `ws` 8.20.1. The SDK's own code is unchanged in 0.8.12 (a reordered bundle); the live routes check passes on every Omniston order route.
- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [6b164bd]
- Updated dependencies [65c3bca]
  - @anywalletkit/protocol-swap2-core@0.3.1
  - @anywalletkit/core@0.3.1
  - @anywalletkit/swap2-assets@0.1.3

## 0.2.1

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- c49ff7b: The EVM destination-escrow validator now binds the escrow's fee split and timelocks before the HTLC secret is released (scan F12). `createOmnistonEvmOutputValidator` decodes `immutables.parameters` (protocolFee, integratorFee, protocolFeeRecipient, integratorFeeRecipient) and requires the fees to equal the quote's `protocolFeeUnits` / `integratorFeeUnits` exactly, `amount − fees` to equal `outputUnits`, a non-zero protocol fee to go to the quote's `settlementData.protocolFeeRecipientAddress` and a non-zero integrator fee to the quote's integrator; it pins the destination timelock stages (words 4–6) to 1/120/180 s (source stages stay free: TON-source orders carry 0/0/0/0) and refuses disclosure within 45 s of the destination cancellation stage. `EvmOutputValidationInput` and the `validateEvmOutputPosition` hook gain `protocolFeeRecipientAddress`, which the provider passes from the cached quote; a non-zero fee without its recipient in the quote is refused (`quote-missing-protocol-fee-recipient`, `quote-missing-integrator-address`). The validator accepts `onRefusal` and names every refusal (`fee-parameters-shape`, `fee-amounts`, `protocol-fee-recipient`, `integrator-fee-recipient`, `dst-timelocks`, `dst-cancellation-window`, …), like the EVM input validator. Fixtures: ten real destination escrows on Base, Arbitrum, BNB and Polygon.
- eadbb21: The HTLC secret is released only against the context bound when the quote was minted, never against trader/dest taken from the caller's intentId (scan F3/F15). `getQuote` now stores `trader`, `dest`, `srcChain` and `kind` with the cached quote (and the EVM order re-save carries them forward); `buildDeposit`, `registerSignedOrder` and `trackIntent` refuse an intentId whose fields differ (`omniston: intent id does not match the quote it was issued for (<field>)`, trace `intent-mismatch`) and hand only the stored values — and, for EVM-source orders, the signed order's owner — to the position validators, `orderTrack` and the delivery locators. Entries cached before this release carry no binding: they fall back to the signed owner / decoded values with a `legacy-intent` trace for at most 6 h. Status reads without a cached context (completed, expired, swap-kind) are unchanged. A second build of the same quoteId reuses the stored HTLC secret instead of overwriting it, and a failed build clears the secret only if it created it. The intentId format is unchanged.
- 21580dd: HTLC secrets are now bound to the order they were made for: trader, destination, source chain, assets and units. A stored secret is reused only for that exact order; a disclosed one is never handed to a new build; and a quote whose platform-issued id already carries an order is refused.
  
  The fixed attack: a malicious platform reusing a quoteId on a shared server could make a victim sign an order locked to a preimage the resolver already knew.
  
  The secret store's format is unchanged. The binding and the disclosure mark live under `<quoteId>#bind` and `<quoteId>#disclosed`, and completion clears all three.
- 3e66a65: EVM → TON disclosure, second blocker: the TON output-position validator required the authority cell to name the recipient, but EVM-source positions carry `addr_none` there (live 2026-10-20, every Base → TON order); the payout target is bound in the terms cell and the pinned authority key still applies. `addr_none` is accepted, any other address is still refused.
- 3bf89fa: EVM → TON disclosure: the EVM input validator no longer demands the source complement's amount to equal `resolverSendsUnits` for a TON destination — Omniston records a larger figure there (live: 1.089 ×), and strict equality blocked every EVM → TON secret disclosure; the delivered amount is proven on the TON position. EVM destinations keep the exact check. New `trace` option reports why a poll skipped disclosure (`disclosure-skipped`, `validator-refused`, `validator-threw`) and when it disclosed.
- 80382a5: EVM → TON orders report the delivery transaction: `locateTonDelivery` on the provider options, called when a completed order's output chain is TON, and `createOmnistonTonDeliveryLocator({tonApiUrl, tonApiKey, fetch})` in `validators` — the output position's jetton transfer to the recipient in the recipient's tonapi events, returned as the event id `@anywalletkit/wallet-ton`'s history source uses for the same event, so a wallet can pair the TON receive with the swap. Omniston's feed names the position but never that transfer; every completed Base → TON order so far carried no `destTxHash` and showed as a swap plus a stray receive.
- d759eff: EVM → TON disclosure, third blocker: a live TON output position (tag 1, awaiting completion) carries a 29-bit root tail, while the validator only knew the settled / rolled-back layout (5 bits — the shape the fixtures were cut from), so every disclosure attempt inside the window was refused and every order rolled back. Both widths are accepted; every fund-critical field is still bound in the refs. Replayed on a saved live snapshot inside its window: passes.
- a6c8a54: TON↔TON swaps: the built message's DEX call is now decoded before the wallet signs it (scan F11). STON.fi v1/v2 (incl. pTON v1/v2 native input and v2 cross-swaps), DeDust v1 and DeDust CPMM v2 bodies must pay the destination, refund and return excess to the trader, carry an on-chain minimum at or above the quote's `minOutputAmount`, and name no referral other than the integrator; unknown layouts, unsupported protocols and split/multi-route quotes are refused as `ton-swap-payload <reason>`. New `validateTonSwapLeg` (returned by `createOmnistonTonValidators`, so spreading hosts need no change) checks on chain that each hop's ask wallet is its router's wallet of the quoted output, that a native-input pTON wallet belongs to the router, and that a DeDust pool trades the quoted pair. `tonSwapPayloadCheck: "report" | "enforce"` (default `"enforce"`; every body captured live on 2026-10-22 passes). STON.fi v1 native input (GRAM→USDT at larger sizes: a jetton transfer to the router's pTON v1 wallet) now builds instead of being refused.
- 3399e00: Validators report why they refuse: `createOmnistonEvmInputValidator({onRefusal})` and `createOmnistonTonValidators({onRefusal})` call the hook with a reason (`no-fill-event`, `immutables-mismatch`, `receipt-or-confirmations`, `past-disclosure-margin`, `escrow-state`, `account-fetch`, `position-code-hash`, `state`, `deploy-transaction`, `error`, …) and the numbers compared — never a secret. A refusal was a silent `false` before, which cost four live orders their disclosure window on 2026-10-20 before the cause could be read.
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
- Updated dependencies [0d68fda]
- Updated dependencies [6568e08]
- Updated dependencies [06cecff]
- Updated dependencies [24b888a]
- Updated dependencies [bdc77c2]
- Updated dependencies [4fcb9b6]
- Updated dependencies [d08e37e]
  - @anywalletkit/core@0.3.0
  - @anywalletkit/protocol-swap2-core@0.3.0
  - @anywalletkit/swap2-assets@0.1.2

## 0.2.0

### Minor Changes

- 1fe0b26: EVM ↔ EVM orders and X Layer, HyperEVM and Plasma; the RPC/indexer validators and audited contract tables move into the package (`./validators`). The destination-escrow proof now requires the immutables to derive to the announced escrow through the trusted factory; one HTLC execution by default (matches the TON escrow validator).
- 384c562: EVM → TON orders (gasless 1inch-LOP-fork typed orders) are implemented end to end: `trustedEvmOrderProtocols` (per-chain allowlist of the order protocol the wallet approves and signs against, separate from the escrow-factory table), `buildDeposit` returns a typed-order `UnsignedTx` after verifying the EIP-712 order, the pinned v1beta8 extension (with the live `allowedTime`/auction-start windows) and the serialized order details, `registerSignedOrder` hands the signature to Omniston, and `trackIntent` discloses the secret only after the `validateEvmInputPosition` (finalized `SrcEscrowCreated` + escrow state) AND `validateTonOutputPosition` (factory-deployed TON position with bound state) hooks both prove the positions. The hooks' inputs changed from the reserved shapes.

### Patch Changes

- 29af9d6: EIP-712 domain `chainId` sent as a string (hex "0x89" or decimal) is now hashed as a NUMBER. viem includes `chainId` in the EIP712Domain type only for numeric values, so such typed data was signed over a domain without chainId and the verifying contract rejected the signature (Omniston EVM→TON order on Polygon, 2026-10-16: registered, never filled). `WalletAccountEvm.signTypedData` normalizes (and the cross-chain guard now recognizes hex strings), the swap2 engine normalizes before handing typed orders to any signer, and the Omniston provider returns typed data with a numeric chainId.
- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
- Updated dependencies [412164a]
- Updated dependencies [f427dec]
- Updated dependencies [7004ecf]
- Updated dependencies [e0edbf6]
- Updated dependencies [29af9d6]
  - @anywalletkit/core@0.2.0
  - @anywalletkit/protocol-swap2-core@0.2.0
  - @anywalletkit/swap2-assets@0.1.1

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`anywalletkit` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @anywalletkit/core@0.1.0
  - @anywalletkit/protocol-swap2-core@0.1.0
  - @anywalletkit/swap2-assets@0.1.0

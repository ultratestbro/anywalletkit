# @anywalletkit/protocol-swap2-omniston

## 0.5.0

### Minor Changes

- cc569c7: An Omniston quote id reused by the platform can no longer replace the terms of a quote the app already holds (scan 2026-10-30 F6). The intent id now carries a digest of the quote's terms (assets, units, fees, resolver, settlement parameters, deadlines) on its dest segment (`<dest>#<digest>`, so apps already released still read the id). A held quote id is refreshed only by a quote with the same terms; a reused id with other terms is refused and the first quote kept, with or without the store's `claim`. `buildDeposit` and `registerSignedOrder` compare the cached quote with the intent's digest and refuse a mismatch with "quote was replaced — request a fresh quote". **Breaking:** an intent id issued by a previous version (no digest) is refused on build with "request a fresh quote"; tracking still reads it, so orders in flight across the update keep their disclosure.
- f934b96: Same-chain TON swaps prove the token the DEX pays out (scan 2026-10-30 F8). `validateTonSwapLeg` is now required, next to `validateTonJettonWallet` and `validateTonSwapTarget`, to advertise and build TON → TON swaps; before, a host without it got only a `ton-swap-payload legs-unverified` trace, and a genuine STON.fi or DeDust body that paid out another token at the quoted minimum was signed. `omnistonVerifyBuild` refuses a TON swap body without `validateTonSwapLeg`. `tonSwapPayloadCheck: "report"` still builds without it (and traces `legs-unverified`) as an explicit opt-in. `createOmnistonTonValidators()` supplies the hook; every live STON.fi v1/v2 and DeDust v1/CPMM v2 layout passes it.

### Patch Changes

- ed84693: A feed `TRADE_STATUS_FULLY_FILLED` no longer deletes a live order's HTLC secrets (scan 2026-10-30 F10). `trackIntent` reports an order `completed` — and clears its secrets and quote context — only when every execution's secret was disclosed (in that poll or an earlier one; a terminal snapshot that lists no executions counts a recorded disclosure) or `locateEvmDelivery` / `locateTonDelivery` found the payout. Otherwise the order stays `pending` with its secrets until TTL or the app's refund backstop closes it, so a real execution that shows up later is still disclosed, and a disclosure that failed in the same poll is retried. Before, a feed that said FULLY_FILLED with no executions made the SDK report completion and forget the secret of a funded order. Disclosed execution indices are recorded under `<quoteId>#disclosed-indices` in the secret store; orders disclosed by the previous version complete as before.
- Updated dependencies [9e27fc6]
  - @anywalletkit/protocol-swap2-core@0.9.0

## 0.4.0

### Minor Changes

- 12fc609: A remote typed order is opened on the device before it is signed (scan 2026-10-28, F6). The engine bound only the domain, the maker and the input of a backend's EIP-712 order; `takingAmount`, the receiver, `makerTraits` and the extension were the backend's.
  
  - **Engine:** a remote stub's typed order is signed only when the stub has the app's own `verifyBuild`, as for TON cell bodies. `UnsignedTx` gains `orderExtension` (0x-hex), the order extension the salt commits to; a build with it but without `typedData` is refused as ambiguous.
  - **Omniston:** EVM-source builds carry `orderExtension`, and `omnistonVerifyBuild` now opens EVM typed orders (EVM → TON, EVM → EVM): the 1inch v4 domain on a trusted order protocol and the source chain, the exact Order schema, the trader as maker selling exactly the input, `takingAmount` at least the quote's minimum and the app's floor, a single-fill order with no allowed sender or series and an expiry minutes away, the salt committing the extension, and in the extension the pinned v1beta8 auction and fee terms, one trusted escrow factory as target, the whitelisted resolver as the order's receiver, the destination chain and token, the audited timelocks, the TON destination token and recipient, and the quote id. New options `trustedEvmOrderProtocols` / `trustedSettlementContracts` (default the audited tables). The HTLC hashlock is the server's, as is the secret.
  
  **Breaking:** without `verifyBuild` a remote typed order is refused, and `omnistonVerifyBuild` refuses an EVM order without `orderExtension`: deploy the server on this release before the app, or remote EVM → TON and EVM → EVM orders are refused. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

### Patch Changes

- Updated dependencies [834c24d]
- Updated dependencies [88a4582]
- Updated dependencies [12fc609]
  - @anywalletkit/core@0.7.0
  - @anywalletkit/protocol-swap2-core@0.8.0
  - @anywalletkit/swap2-assets@0.2.2

## 0.3.1

### Patch Changes

- c6ca19d: Remote TON → EVM orders work again. On 0.3.0, `omnistonVerifyBuild` could only open TON → TON swap bodies, so every TON → EVM order through `remoteProvider` was refused ("only TON swap bodies can be checked on the client") and apps turned the route off.
  
  Now `createOmnistonTonValidators()` also returns `verifyTonEscrowBuild`, and `omnistonVerifyBuild({...createOmnistonTonValidators()})` sends TON → EVM escrow bodies to it. It runs the server's structural check (`validateTonEscrowPayload`'s layout).
  - **From the app:** every field that decides where the trader's money goes — the jetton amount, the trader as owner and refund address, the destination chain, address and token, and a delivery of at least the quote's minimum.
  - **Pinned:** the protocol contract, from `trustedProtocolAddresses`, by default the audited `AUDITED_OMNISTON_SETTLEMENT_CONTRACTS["ton:-239"]`.
  - **Read from the body and held to the audited pins:** the fields the server and the resolver choose — quote id, resolver, hashlock, exclusivity, deposit. The audited pins are escrow and execution code, the authority key, one execution, the reviewed timelocks and no Dutch auction.
  
  Checked on the live TON → EVM escrows captured on 2026-10-10 (USDT on TON → USDC on Base and on BNB), and in the Hermes VM.

## 0.3.0

### Minor Changes

- c07728c: A reused quote id can no longer rebind an order after its HTLC secret exists. `trackIntent` discloses a secret only when the context it is checked against is the exact order the secret was locked to (its stored binding of trader, destination, chain, assets and units) — a context rewritten under the same quote id after the secret was made gets nothing. A fresh quote's context is claimed instead of overwritten, in the order and the TON-swap paths alike: another user's quote under a held id is refused, the same user's re-quote refreshes it. `OmnistonQuoteStore` takes an optional atomic `claim(quoteId, json)` (create-if-absent; the in-memory store has one) — **give your durable store one**, or claiming falls back to check-then-save. The TON-source build re-saves its bound context, as the EVM build does.
- 28c7d3a: The engine signs a provider's EIP-712 payload only when it is the swap's own order: a Limit Order Protocol `Order` whose `domain.verifyingContract` is the settlement contract the swap approves (for a remote stub, a pinned spender), on the source chain, with this account as `maker`, the source token as `makerAsset` and exactly the input as `makingAmount` (hex or decimal). A `Permit`, `PermitSingle`, `PermitBatch`, `PermitTransferFrom*` or any other `primaryType` is refused before anything is approved or signed — a backend's build could hand the wallet an EIP-2612 permit to itself and the engine signed and posted it. `remoteProvider` takes `verifyBuild(quote, tx)` (the provider's own check of a build, run on the client) and **refuses an absolute `baseUrl` that is not `https:`** (a same-origin path is fine; `allowInsecureBaseUrl: true` for local development). Omniston exports `omnistonPins(trustedEvmOrderProtocols)` — the app's audited order protocols as the remote stub's spenders — and `validateEvmTypedOrder`.
  
  **Breaking:** `remoteProvider` refuses a `baseUrl` that is not https — a same-origin path is fine, `allowInsecureBaseUrl` is for local development; typed data is signed only when it is the swap's own `Order`. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.
- a4ceb50: A TON cell-body deposit (`bodyBoc`) is bound to the swap on the client instead of being sent as the build said. The message may attach the input plus at most `tonGasCeiling` nanoTON of gas (new engine option, default 1 TON; live Omniston swaps attach 0.1–0.7) — a jetton source the ceiling alone. A jetton source's body must be a TEP-74 transfer of exactly the input, from this account's own jetton wallet (the account's `getJettonWalletAddress`; an account without it cannot execute such a swap), with the excess returning to this account. The decoded body reaches `reviewExecution` (`cellBodyDecoded`, next to `cellBody: true`). **A remote stub's cell body is refused unless the app gave it `verifyBuild`**, and a remote native-source body must go to a pinned `callTargets` address when the app pins any. Before, `{to: attacker, value: <whole balance>, bodyBoc}` or a transfer of the whole jetton balance to the attacker from the user's own jetton wallet went to the account untouched. `verifyBuild` now also receives the request the quote answered, and may be async; the router keeps a stub's `verifiesBuilds` flag. `tonRawAddress` (friendly/raw TON address comparison without @ton/core) is exported.
  
  Omniston: `omnistonVerifyBuild({validateTonSwapTarget, validateTonSwapLeg, integratorAddress})` is the app's check of a remote TON swap build — `checkTonSwapPayload` against the app's own request plus the app's DEX validators; swap quotes carry `providerData.routeSteps` for it. A TON → EVM escrow body cannot be checked on the client and is refused by the helper.
  
  **Breaking:** a jetton-source TON swap needs a signer with `getJettonWalletAddress`; a TON transaction carrying more than the input plus `tonGasCeiling` (1 TON) is refused; a remote cell body needs `verifyBuild`. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

### Patch Changes

- 0e43992: Follow-ups from a review of the modules-scan fixes against the code (2026-10-28).
  - **CCIP-Read is off** in every viem client the SDK creates: wallet-evm, approvals and the protocol modules. names-ens keeps its own filtered one. A contract's `OffchainLookup` revert no longer makes the device fetch URLs it names, LAN addresses included. Two cases were reachable: an approvals scan calls every contract that emitted an Approval naming the user, spam tokens included, and wallet-evm reads tokens the user added.
  - **networks:** `isPrivateHost` treats a host that is not printable ASCII as private. A URL parser maps `127.0.0.１`, `127。0。0。1` and `ｒｏｕｔｅｒ.ｌａｎ` to 127.0.0.1 and router.lan (IDNA), so these got past `isPublicHttpsUrl`. Names in other scripts arrive as punycode and stay public. 6to4 addresses (`2002::/16`) carry their IPv4.
  - **tokens:**
    - The look-alike danger rule now also covers more lettering: Roman numerals, small capitals from Latin Extended-D/E, enclosed letters of the supplement (🅤), Tifinagh, Vai, Deseret, Osage, Lycian, Carian, Old Italic, Warang Citi and Georgian's look-alike letters.
    - It now covers more characters that hide: C0 and C1 controls, line breaks inside a symbol, the braille blank, interlinear annotation, tag characters (ASCII smuggling) and astral format controls.
    - It reads the stored symbol as well as the raw head, so leading spaces cannot push a look-alike out.
    - Fewer false alarms: ™ ℠ ℗, the tag-sequence flag emoji and ZWNJ in Persian or Indic spelling stay a caution.
    - `foldSymbol` drops spaces after NFKD, so "USDC´" reads as USDC.
  - **names-ens:** `ipfsGateway` may be an origin (`/ipfs/<cid>` is appended, as before the fix) or a prefix ending in `/ipfs/`.
  - **approvals:** `isRevokeTransaction` never throws, and `targets` may also be a plain object or `[address, standard]` pairs.
  - **mellow:** `claimWithdrawals` claims only on pinned redeem queues, like every other queue call.
  - **swap2-core:** `remoteProvider` trims `baseUrl` and refuses a scheme-relative one (`//host`). A leading space or `//` used to get past the https check.
  - **omniston:** `createOmnistonTonValidators()` declares the validators it always returns as required, so `omnistonVerifyBuild({ ...createOmnistonTonValidators() })` typechecks.
- Updated dependencies [c59c8cc]
- Updated dependencies [f1a46e4]
- Updated dependencies [418fea1]
- Updated dependencies [28c7d3a]
- Updated dependencies [a4ceb50]
- Updated dependencies [0e43992]
  - @anywalletkit/protocol-swap2-core@0.7.0
  - @anywalletkit/swap2-assets@0.2.2

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

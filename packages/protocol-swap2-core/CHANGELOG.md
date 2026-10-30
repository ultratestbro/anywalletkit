# @anywalletkit/protocol-swap2-core

## 0.9.0

### Minor Changes

- 9e27fc6: A remote stub's EVM calldata on a pinned contract needs the app's own check of the call (scan 2026-10-30, F3). A pinned contract executes whatever its arguments say — a CCTP burn's `mintRecipient`, an OFT send's `to`, a Diamond call's receiver — so the pin alone did not bind the call to the request. `remoteProvider` now marks a stub given `verifyQuote` with `verifiesQuotes` (as `verifyBuild` sets `verifiesBuilds`), the router keeps the marker in its snapshot, `remotePinRefusal` drops a remote EVM calldata quote from a stub with neither, and the engine refuses such a build before any approval.
  
  **Breaking:** a remote stub with hand-made `callTargets` and no `verifyQuote` / `verifyBuild` gets no EVM calldata route. Every shipped EVM pins export carries a check (`lifiPins`, `cctpPins`, `usdt0Pins`, `wrapPins`, `uniswapPins`, `balancerPins`, `fyndPins`, `chainflipPins`, `thorchainPins()`); Omniston keeps its app-supplied `verifyBuild: omnistonVerifyBuild(...)`, which satisfies the rule. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

## 0.8.0

### Minor Changes

- 88a4582: A remote stub's deposit-address and plain-value routes need the app's opt-in (scan 2026-10-28, F9). The pins applied only to builds with calldata, so a pinned calldata stub (LI.FI, CCTP, Uniswap, Balancer, wrap, USDT0, Chainflip) could answer with `depositAddress` = the backend's address, or a plain value send, and the engine paid it.
  
  - **Core / router:** `remoteProvider({depositAddressRoutes: true})` (also a `RemotePins` field) opens a stub to routes that pay an address its backend names. Without it, the engine refuses such a build and `remotePinRefusal` drops such a quote in the router and the single-provider path, on every chain. The router keeps the flag in its snapshot.
  - **NEAR Intents:** new `nearIntentsPins` — no call targets, no spenders, `depositAddressRoutes: true` (1Click deposit addresses are minted per quote).
  - **THORChain:** `thorchainPins()` set `depositAddressRoutes`: the Tron vault is the one `verifyBuild` confirms with two THORNodes.
  - **Chainflip:** `chainflipPins` set `depositAddressRoutes` and carry `verifyQuote: chainflipVerifyQuote`, the provider's own decode on the device: an EVM vault call on the pinned Vault, or a Tron send to the pinned Tron Vault whose note names the app's destination, refund address and a minimum price that guarantees the quoted minimum, with no DCA, boost, broker fee or affiliates; and `verifyBuild` requires the Tron note to go as hex bytes.
  
  **Breaking:** a remote stub without `depositAddressRoutes` gets no deposit-address or plain-value route — spread `...nearIntentsPins` into your NEAR Intents stub (THORChain's and Chainflip's pins already carry it); a remote Chainflip quote that fails `chainflipVerifyQuote` is refused. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.
- 12fc609: A remote typed order is opened on the device before it is signed (scan 2026-10-28, F6). The engine bound only the domain, the maker and the input of a backend's EIP-712 order; `takingAmount`, the receiver, `makerTraits` and the extension were the backend's.
  
  - **Engine:** a remote stub's typed order is signed only when the stub has the app's own `verifyBuild`, as for TON cell bodies. `UnsignedTx` gains `orderExtension` (0x-hex), the order extension the salt commits to; a build with it but without `typedData` is refused as ambiguous.
  - **Omniston:** EVM-source builds carry `orderExtension`, and `omnistonVerifyBuild` now opens EVM typed orders (EVM → TON, EVM → EVM): the 1inch v4 domain on a trusted order protocol and the source chain, the exact Order schema, the trader as maker selling exactly the input, `takingAmount` at least the quote's minimum and the app's floor, a single-fill order with no allowed sender or series and an expiry minutes away, the salt committing the extension, and in the extension the pinned v1beta8 auction and fee terms, one trusted escrow factory as target, the whitelisted resolver as the order's receiver, the destination chain and token, the audited timelocks, the TON destination token and recipient, and the quote id. New options `trustedEvmOrderProtocols` / `trustedSettlementContracts` (default the audited tables). The HTLC hashlock is the server's, as is the secret.
  
  **Breaking:** without `verifyBuild` a remote typed order is refused, and `omnistonVerifyBuild` refuses an EVM order without `orderExtension`: deploy the server on this release before the app, or remote EVM → TON and EVM → EVM orders are refused. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

### Patch Changes

- Updated dependencies [834c24d]
- Updated dependencies [eb628a8]
  - @anywalletkit/core@0.7.0
  - @anywalletkit/tx-preview-evm@0.4.0
  - @anywalletkit/swap2-assets@0.2.2

## 0.7.0

### Minor Changes

- c59c8cc: `decodeCall` reads the approval and transfer calls the way the EVM executes them, not with a strict ABI decoder: selectors in any letter case, calldata that is too short zero-padded, address words by their low 20 bytes, any non-zero bool word as `true`. Before, `0x095EA7B3…` approves, a WETH9 approve one byte short and `setApprovalForAll(operator, 2)` threw in the decoder and showed as plain calls while the token contract executed them. Every Permit2 `approve(token, spender, uint160, uint48)` is an approval at any address (zkSync Era's Permit2 is not the CREATE2 one). Calldata that is not hex bytes is `undecodable: true` on the `DecodedCall` and a new `calldata-undecodable` warning in `checksFor`. swap2's quote and claim calldata gates refuse undecodable calldata.
  
  **Breaking:** swap calldata that is not hex bytes is refused (it used to pass as a plain call). Approve and transfer calldata a strict ABI decoder rejected (an upper-case selector, a short last word, a non-canonical bool) is now read as the approval or transfer the token executes, and checked like one. A review can show the new warning code `calldata-undecodable`. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.
- f1a46e4: Text and calldata from a page, a client or an API are bounded before anything parses them. extension-kit: an error message is cut to its first line within 1 KB before its URLs are taken out (the URL regex has a bounded scheme), and a request's `method` must be a method name — letters, digits and `_`, at most 128 (`isRelayMethod`, `RELAY_METHOD_MAX`) — or the relay drops it and the router answers -32600 without echoing it. swap2-core: `redactUrls` is linear whatever the text (it also catches a URL right after `_` or glued to a long word now), and the server cuts a provider's refusal or error before redacting it. Balancer: `preflightDeposit` decodes and prices only the quote's own batch — a client's different `tx.data` is refused before it is decoded — with at most `BALANCER_MAX_SWAPS` (16) hops and no pool `userData`, and a longer SOR route is refused at the quote. Fynd: `preflightDeposit` simulates only the quote's own transaction (target, calldata, value), a refusal names the transaction target only when it is an address, and protocol names from the API are cut to 40 characters.
  
  **Breaking:** extension-kit drops a relay request whose `method` is not a method name (answer it with -32600 in your injected provider); Balancer `preflightDeposit` refuses calldata that is not the quote's own batch, and Fynd's a transaction whose target, calldata or value differs from the quote's. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.
- 418fea1: A remote provider's addresses come from the app, never from its backend. `remoteProvider` takes `callTargets(chain)` / `spenders(chain)` — the provider package's pins, spread in: `lifiPins`, `fyndPins`, `uniswapPins`, `chainflipPins`, `cctpPins` (with its `claimTargets`), `usdt0Pins`, `balancerPins`, `wrapPins` — and an optional `verifyQuote(params, quote)` that runs the provider's own check on the client (`fyndPins` carries `fyndVerifyQuote`: `checkFyndTransaction` against the app's request). The stub is marked `remote: true`; the engine then lets its EVM routes call only pinned targets and approve only pinned spenders. **Fail closed: a remote stub without pins gets no EVM calldata route or approval** — the router and the single-provider path drop such a quote with the reason (`remotePinRefusal`), deposit-address routes need no pins. Wire the pins in every app that proxies providers through `createSwap2Handler`.
  
  For every provider, a token call in a swap's calldata must move the source token, at most the swap amount, to this account, the deposit address of a deposit-address route, or the declared spender (for a remote stub: the pins); `setApprovalForAll` and Permit2 `approve` are never a swap's main call, and `transferFrom` is refused. Before, `{to: USDC, data: approve(attacker, MAX), approvalAddress: attacker}` from a backend, or `cbBTC.transfer(attacker, all)` with `depositAddress = attacker`, passed because the allowlist was the response's own addresses. The router's provider snapshot now keeps the remote marker and the pins (dropped there, execution through the router took a remote stub for a local provider).
  
  **Breaking:** a `remoteProvider` without `callTargets` / `spenders` gets no calldata route on EVM — spread the provider's pins (`lifiPins`, `fyndPins`, …); swap calldata may only move the source token, by at most the input; an operator or Permit2 approval or a `transferFrom` as the swap call is refused. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.
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
  - @anywalletkit/tx-preview-evm@0.3.0
  - @anywalletkit/swap2-assets@0.2.2

## 0.6.1

### Patch Changes

- b1350b4: Every type a public signature uses is exported, so the API reference documents it and apps can name it: the provider config types (`LifiSwap2Config`, `BalancerSwap2Config`, `NearIntentsSwap2Config`, `FyndSwap2Config`, …), the explorer client options in history-evm (`EtherscanClientOptions`, `AlchemyClientOptions`, `BlockscoutClientOptions`), `Swap2ExecutionPhase`, the Omniston client shapes, and the row / view types the chain packages already expose through their methods. Type-only additions, plus the account-meta role constants of native SOL staking (`READONLY`, `WRITABLE`, …). Renames on export: Aave and Morpho activity `Action` → `AaveActivityAction` / `MorphoActivityAction`; conformance `ProtocolCtor` / `WriteProtocolCtor`; history-evm `RawRow`.
- eb14cb5: npm metadata: every package has a description and the `anywalletkit` keyword. The LI.FI, NEAR Intents, Omniston and THORChain packages had an empty description, so npm showed the README badge markdown in its place, and 24 packages were missing from a `keywords:anywalletkit` search. `pnpm pack:check` now refuses a package without either.
- Updated dependencies [eb14cb5]
  - @anywalletkit/core@0.6.1
  - @anywalletkit/swap2-assets@0.2.2

## 0.6.0

### Minor Changes

- b55aa5d: `claimSwap2` now returns a status id that carries the claim transaction's hash (`awk1.<provider>.<intent>.<sourceHash>.<claimHash>`), and `getSwap2Status` passes it to the provider as `destTxHash`. A two-phase route (CCTP) whose provider has no destination RPC used to stay "action-required" after the claim; it now completes. Older ids keep working.
- b55aa5d: `claimSwap2` now calls only a contract the provider declares for the destination chain (new `CrossChainProvider.claimTargets(chain)`; CCTP: its MessageTransmitter), and refuses claim calldata that moves the account's tokens or grants an allowance. A provider with a claim step must declare its targets; a remote provider stub takes them from the app (`remoteProvider({ claimTargets })`, e.g. `cctpClaimTargets` from `@anywalletkit/protocol-swap2-cctp`), never from the server. The router passes them through.
- b55aa5d: `getSupportedTokens()` now gives each token's contract address (the symbol for a native coin) as `token`, the identifier `quoteSwap2` / `swap2` take back. It used to give the provider-specific `assetId`, which is `""` for most catalog entries, and an empty token resolved to the native coin. An empty or blank `fromToken` / `toToken` is now refused with `Swap2ValidationError`.

### Patch Changes

- d82e140: `policies.maxFee` now reaches Tron's `signRaw` (second argument), an account's `revokeDelegation` (its only argument) and swap2's `sendSerializedTransaction` hook (third argument) as `{ maxFee }`, and the hook / approvals types say so. Under a fee cap, a write that pays a fee but cannot take one (NEAR `signBuilt`, Solana `signCompiled` / `signTransactionMessage`, name-guarded helpers) is refused instead of signed unchecked; off-chain signatures (messages, typed data, permits) are not affected. The conformance mock records the hook's options.
- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- b55aa5d: On a deposit-address route (a quote without `txRequest`), the provider's build may no longer carry calldata, a spender (`approvalAddress`) or a serialized transaction the quote never had; such a build is refused before anything is approved or sent.
- b55aa5d: A deposit whose broadcast answer was lost is reported as `Swap2MaybeSentError` (no approval revoke, no retry) in more shapes: every chain package's `BroadcastUnknownError` anywhere in the cause chain, undici's `fetch failed` with an `UND_ERR_*` cause, React Native's `Network request failed`, an error code only on the cause (`ECONNRESET`…), a `TimeoutError`. A node's explicit refusal (`answered: true`) stays a clean failure even when its message mentions a timeout.
- Updated dependencies [f743c06]
- Updated dependencies [f743c06]
- Updated dependencies [d82e140]
- Updated dependencies [f743c06]
- Updated dependencies [398129f]
- Updated dependencies [eec3745]
  - @anywalletkit/core@0.6.0
  - @anywalletkit/swap2-assets@0.2.1
  - @anywalletkit/tx-preview-evm@0.2.0

## 0.5.0

### Minor Changes

- 0d0e46e: Swaps of tokens the catalog does not list (a user's own tokens, named by EVM contract or Solana mint), opt-in with `allowUnlistedTokens: true` on the engine and on `createSwap2Handler`; off by default, nothing changes without it. The engine reads the source token's decimals with the account's `getTokenInfo` (cached; a disagreeing `fromTokenDecimals` is refused) and sends them as `QuoteParams.sourceDecimals`; approvals go to the named token for the exact amount and the quoted spender, with the same value binding as catalog tokens. LI.FI, Uniswap, Balancer and Fynd resolve the source with the new `sourceAssetOf(params)`; providers with their own asset lists keep refusing. `swap2-assets` adds `isTokenAddress`, `unlistedAsset`, `isUnlisted`, `resolveAsset` (catalog first, always) and `catalogChainId`.

### Patch Changes

- e9cc028: A blank `recipient` / `refundAddress` (`""` from an empty input) is treated as omitted: the swap goes to, and refunds to, the account itself, and the review shows that address. CCTP, USDT0 and LI.FI use their placeholder address only for dry quotes; a live quote without a recipient or refund address is refused instead of being built to the placeholder.
- Updated dependencies [6dde4e4]
- Updated dependencies [b08c01a]
- Updated dependencies [a354990]
- Updated dependencies [0d0e46e]
  - @anywalletkit/swap2-assets@0.2.0
  - @anywalletkit/core@0.5.0

## 0.4.1

### Patch Changes

- 8aa911d: The re-quote after a mined approval is reviewed again when it differs from what `reviewExecution` approved. When the first quote expired while the engine's approval was being mined, the second pass skipped the review and re-checked only spender, amount and `minAmountOut`, so the fresh quote's calldata, call target, deposit, memo, gas limit or a worse expected output reached the signer unseen. The engine now pins the reviewed plan (everything but timing, fee estimate, ETA and the mined approvals) and calls `reviewExecution` again with the fresh plan, `requoted: true` and empty `approvals` when anything pinned changed or `destAmount` dropped; throwing there, or the fresh quote expiring during that review, revokes the allowance exactly once and sends nothing. An unchanged or better re-quote is not asked again. A gas check that fails on the re-quote pass (the fresh call does not estimate, or the balance no longer covers it) now revokes the adopted allowance too; it was left live. New optional `Swap2ExecutionPlan.requoted`. Audit 2026-10-25 (post-release), M2.
- 8aa911d: `createSwap2Handler` seals a quote only when it passes the engine's own `validQuote` (the provider that was asked, the asked input amount, `minDestAmount` ≤ `destAmount`, the caller's `minAmountOut` and `slippageBps`, a live expiry, sane fees / ETA / reliability); otherwise the quote action answers 502. It sealed any well-formed quote, so a client that does not re-validate (anything but the SDK's `remoteProvider`) could get a sealed quote the engine would refuse. Audit 2026-10-25 (post-release), L1.
- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1
  - @anywalletkit/swap2-assets@0.1.5

## 0.4.0

### Minor Changes

- c4dc4d6: `createSwap2Handler` binds quotes and swaps to the caller (audit 2026-10-25, finding 12). A sealed quote and an intent id used to be good for any caller: one user could build another's quote, and anyone could ask about any swap (deposit addresses are public on chain), notify it or register against it.
  
  - Every quote's `intentId` leaves with an intent token appended (`<id>~<tag>`, HMAC under `sealSecret`); `track`, `claim`, `notify` and `register` refuse an id without a valid token (403), and the provider only ever sees its own id. The app, `remoteProvider` and the swap2 engine need no change: the swap id the engine hands out carries the token.
  - New `subject(context)`: the authenticated user (the Sign-In with Ethereum address, not an email). Quotes are sealed for it and tokens issued to it, so another user's quote or swap id is refused (403). Without it the token is a bearer capability for that one swap.
  - New `acceptUntokenedTrackUntil`: while moving from another backend, `track` (read-only) accepts ids without a token until that time.
  - `guard` now runs after validation and receives the validated request (`call.request`, with the provider's own intent id), so limits can depend on what is asked.
- ed99146: New `@anywalletkit/protocol-swap2-core/server`: `createSwap2Handler({ providers, sealSecret, guard })`, the server side of `remoteProvider`. Framework-free (`handle(action, body, context)` → `{status, body}`), it validates every field, seals quotes with HMAC-SHA256 and refuses `build` / `preflight` on an unsealed, altered or expired quote, passes a provider's named refusal through with URLs redacted, and requires a `guard` for authentication and rate limiting. WebCrypto, server-only (Node ≥ 20, edge runtimes); not part of the main entry, so apps never bundle it.

### Patch Changes

- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- a9a5e0a: package.json carried a second, empty `description` that overrode the real one, so npm showed the README badge line instead of the package description.
- Updated dependencies [07db4c1]
- Updated dependencies [80d6451]
- Updated dependencies [a9a5e0a]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
  - @anywalletkit/core@0.4.0
  - @anywalletkit/swap2-assets@0.1.5
  - @anywalletkit/tx-preview-evm@0.1.4

## 0.3.2

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2
  - @anywalletkit/swap2-assets@0.1.4
  - @anywalletkit/tx-preview-evm@0.1.3

## 0.3.1

### Patch Changes

- 6b164bd: The engine accepts the genesis-hash chain ids the wallet packages report (`solana:5eykt…`, `tron:0x2b6653dc`, `bip122:000000000019d6689c085ae165831e93`) as `fromChain`, `toChain` and the account's chain, and maps them to the swap2 ids (`solana:mainnet`, `tron:728126428`, `bitcoin:mainnet`). Previously `fromChain: account.chain` with a Solana, Tron or Bitcoin account found no route, and the short id failed the account-chain check, so an SDK account could not swap from those chains. `swap2ChainId()` and `SWAP2_CHAIN_ALIASES` are exported.
- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [65c3bca]
  - @anywalletkit/core@0.3.1
  - @anywalletkit/swap2-assets@0.1.3
  - @anywalletkit/tx-preview-evm@0.1.2

## 0.3.0

### Minor Changes

- 0d68fda: New provider `@anywalletkit/protocol-swap2-chainflip`: Chainflip vault swaps (native BTC / ETH / SOL / TRX, USDC / USDT) from Ethereum, Arbitrum and Tron into Ethereum, Arbitrum, Solana, Tron and Bitcoin through Chainflip's public backend (no broker account, 0 bps). The encoder's output is decoded and checked before anything is signed (vault, destination chain / asset / address, amount, refund = sender, min price ≥ ours, no DCA / boost / broker fee / affiliates); fill-or-kill refunds to the sender. Tron sources are a TRC-20 transfer to the Vault with the swap as a binary note, so `UnsignedTx.memoEncoding` (`"utf8"` default, `"hex"`) is new in swap2-core and `wallet-tron` accepts `memoEncoding` on transfers and contract calls (`memoBytes` exported).
- 6568e08: Renames: the base of every swap2 error is now `Swap2Error`; the pinned derivation vectors are exported as `derivationVectors` and shipped as `vectors/derivation.json` (values unchanged). The approvals module drops its policy-engine rule set and its `Policy` / `PolicyRule` / `PolicyContext` types — the kit's policies treat revokes as `kind: 'revoke'` on their own; `isRevokeCalldata` and `isUnlimitedAmount` stay. THORChain's default `clientId` is `anywalletkit`.
- 06cecff: Swap2 status ids decode only under the current `awk1.` prefix. `getSwap2Status`, `claimSwap2` and the extension-kit swap tracker refuse any other prefix as a malformed id; an app still holding ids minted under an earlier prefix maps them to `awk1.` before calling.
- bdc77c2: `suggestSlippage(context, options?)` (also at `@anywalletkit/protocol-swap2-core/slippage`): auto slippage from the pair class (stable ↔ stable 0.1%, majors 0.5%, everything else 1%), half the provider-reported price impact (≤ 1%), a settle-time allowance for cross-chain routes (none for stable ↔ stable) and a quarter of recent volatility (≤ 1%), clamped to [5, 300] bps by default. Returns the parts so an app can show why. The app decides whether to use it and lets the user override.
- 4fcb9b6: TON deposits with a memo: `transfer({memo})` on a TON account sends it as the jetton forward-payload comment (TEP-74) or the native message comment (memo + forwardPayload together is refused), and swap2-core now executes TON jetton deposits that carry a memo through that surface, like Tron and NEAR token deposits — before, they were refused as not implemented.
- d08e37e: USDT0 no longer puts raw viem transport errors into refusal reasons or preflight errors. Those errors carry `URL: …`, which includes the key of a keyed RPC.
  
  - **USDT0:** an RPC failure becomes `usdt0: RPC for <chain> unavailable — try again`, and any other text loses its URLs.
  - **swap2-core:** new `redactUrls()`. Servers that forward refusal text to clients should pass it through this.

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- 24b888a: A caller's `slippage` decimal reaches the provider as the whole bps it names: 0.0029 is 29 bps, not 28 (0.0029 × 10 000 is 28.999…96 in floating point, and a plain floor shortened 573 of the 10 001 whole-bps values by one). Decimals between whole bps still round down, and the quote check against the decimal uses the same rule.
- Updated dependencies [5d7976e]
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
- Updated dependencies [87f9823]
  - @anywalletkit/tx-preview-evm@0.1.1
  - @anywalletkit/core@0.3.0
  - @anywalletkit/swap2-assets@0.1.2

## 0.2.0

### Minor Changes

- f427dec: Approvals no longer kill the quote (SDK-128). Mainnet USDT needed approve(0)+approve(n), 50–108 s on chain against LI.FI's 55 s / Omniston's 45 s quote TTL, and the engine then aborted with "quote expired before source broadcast" and revoked (a third tx). Two changes: the engine reads the live allowance through the new optional `account.getAllowance(token, spender)` and sends only what the chain needs — a single approve(n) for USDT when the allowance is 0, nothing when the exact amount is already in place (such an allowance is not ours and is left alone on failure), the reset only for a stale non-zero value; and when mined approvals still outlive the quote it re-quotes exactly once (new execution phase `"requoting"`), keeps the exact allowance and spends it. The second pass is bound to the same spender and amount, held to the caller's floor, not reviewed again, and never re-quotes itself; a fresh quote that moves the spender or drops the allowance revokes and aborts. Accounts without `getAllowance` keep the old reset-every-time behaviour.

### Patch Changes

- 412164a: Swap2 status ids are minted as `awk1.<provider>.<intent>[.<sourceTxHash>]` (`SWAP2_ID_PREFIX` exported).
- 29af9d6: EIP-712 domain `chainId` sent as a string (hex "0x89" or decimal) is now hashed as a NUMBER. viem includes `chainId` in the EIP712Domain type only for numeric values, so such typed data was signed over a domain without chainId and the verifying contract rejected the signature (Omniston EVM→TON order on Polygon, 2026-10-16: registered, never filled). `WalletAccountEvm.signTypedData` normalizes (and the cross-chain guard now recognizes hex strings), the swap2 engine normalizes before handing typed orders to any signer, and the Omniston provider returns typed data with a numeric chainId.
- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
- Updated dependencies [7004ecf]
- Updated dependencies [e0edbf6]
  - @anywalletkit/core@0.2.0
  - @anywalletkit/swap2-assets@0.1.1

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`anywalletkit` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @anywalletkit/core@0.1.0
  - @anywalletkit/swap2-assets@0.1.0
  - @anywalletkit/tx-preview-evm@0.1.0

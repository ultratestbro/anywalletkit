# @anywalletkit/protocol-swap2-usdt0

## 0.5.1

### Patch Changes

- 6f70ab1: Refusal reasons. USDT0's refusals keep their text and now carry a `reason` (`Swap2RefusalReason`), as `onRefusal`'s second argument and on the thrown errors (still plain `Error`s with the same message). In `getQuote`, for OFT sends and the Legacy Mesh alike: flexible amounts, a chain without USDT0 or a mesh OFT, the same chain, another token, no RPC for the source and an OFT asking for an LZ-token fee are `unsupported_pair`; a zero amount, the OFT minimum and dust are `amount_too_small`; the OFT maximum is `amount_too_large` on an OFT send and `insufficient_liquidity` on the Legacy Mesh (it is the pool's credit toward Tron / TON), as is a `quoteSend` reverting with `InsufficientCredits`; the caller's floor above the output and an OFT reporting more received than sent are `price_check_failed`; a recipient or refund address the destination cannot pay (another family, a TON workchain other than 0, a testnet address) and the zero account are `recipient_mismatch`; a live quote without its recipient or refund address is `policy_refused`. A token or approval mode the chain reports against the pins, or a peer that is another contract, is `vault_mismatch`; a peer that is not wired at all (zero) is `unsupported_pair`. The source RPC's own failure keeps its fixed text ("RPC for … unavailable — try again") and is classified from viem's error: 429 `rate_limited` with `retryAfterMs` from Retry-After, a node's limit-exceeded answer or a 429 code in its JSON-RPC answer `rate_limited`, 401 / 403 `key_rejected`, any other status (a failing status that comes with a JSON-RPC body is read the same way), a network failure or viem's timeout `upstream_unavailable` (with `httpStatus` when there was one); any other revert of the OFT's read is `simulation_failed`. In `preflightDeposit` (both routes), another deposit target is `vault_mismatch`, a refund to another address and the zero recipient are `recipient_mismatch`, a LayerZero fee that rose past the sealed headroom is `quote_expired`, a placeholder-priced quote, a malformed intent id, missing sealed parameters and any calldata, fee, value or chain off the sealed send are `policy_refused`, and a re-thrown RPC failure keeps the inner classification (a lost peer stays `unsupported_pair`, a rejected key `key_rejected`). `buildDeposit` on a placeholder-priced quote or one without a transaction is `policy_refused`. LayerZero Scan's answers that reach `buildClaim` carry their status (429 `rate_limited` with Retry-After, 401 / 403 `key_rejected`, any other `upstream_unavailable` with `httpStatus`); a network failure, the module's own timeout or a body that is not JSON is the same error tagged `upstream_unavailable`; an incomplete stored packet is `upstream_unavailable` and one stored for another receiver `vault_mismatch`. `usdt0Pins.reasonOf` classifies every text `usdt0VerifyQuote` (and so `usdt0VerifyMeshSend`) returns, so a remote stub's refusal carries it: a route or token this venue does not serve `unsupported_pair`; another recipient, refund address or destination eid, the zero account, or a transaction on a placeholder-priced quote `recipient_mismatch`; another OFT, spender or a deposit address `vault_mismatch`; a minimum below the floor or more out than in `price_check_failed`; amounts that are not integers `upstream_unavailable`; any other call shape, amount, fee or intent `policy_refused`. A quote whose `sourceAmount` is not an integer still makes the check throw; that error's text is classified `upstream_unavailable` the same way. The provider's self-check of its own Legacy Mesh build reports the check's reason. Configuration errors and a non-integer `amountIn` stay unclassified.
- Updated dependencies [fb6ca70]
  - @anywalletkit/protocol-swap2-core@0.12.0

## 0.5.0

### Minor Changes

- ac0270c: USDT into TON — and into Tron, opt-in — through the USDT0 Legacy Mesh, from EVM sources only: Ethereum USDT, Arbitrum USDT0 and Celo USD₮ (`0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`, by contract — the catalog's Celo `USDT` is a bridged token and is refused; through the engine it needs `allowUnlistedTokens` and `getTokenInfo` or `fromTokenDecimals: 6`) to USDT on `ton:-239` (eid 30343) and `tron:728126428` (eid 30420), one `send` on the chain's `UsdtOFT` with an exact approval to it. The contracts come from docs.usdt0.to (deployments API, Legacy Mesh) and were read on-chain on 2026-11-12 (`token()`, `approvalRequired()`, `endpoint()`, `sharedDecimals()` = 6, `feeBps()` = 3, `peers(30420)` / `peers(30343)` = the Tron / TON OFT). At runtime the provider re-reads, once per provider instance, `token()` and `approvalRequired()` on a chain's mesh OFT before the first mesh quote on that chain, and `peers(dstEid)` before the first quote of each source → destination pair (a mismatch refuses the route; a failed read is not cached, so the next quote reads again; preflight reuses the cached results). `endpoint()` and `feeBps()` are not re-read at runtime: `endpoint` is an immutable of the non-proxy `UsdtOFT`, and the module watch (`watch.json`) follows each OFT's code hash and its `feeBps()`; a fee change reaches a quote through `quoteOFT`'s received amount, which the sealed `minAmountLD` then holds. Limits and fees come from the contract: `quoteOFT` (the pool's credit toward the destination caps the amount, the 0.03 % mesh fee is a `protocol` fee row) and `quoteSend` (the LayerZero fee, sealed with the usual 25 % refunded headroom). The recipient is encoded as the destination OFT reads it — Tron base58check → 20 bytes left-padded, TON raw or `EQ…` / `UQ…` → the account hash on workchain 0 (other workchains and testnet addresses are refused) — and every built send is decoded back against the request before it is returned. Right before signing, `preflightDeposit` decodes the deposit again and, before any network read, holds all of it to the sealed send: the target is the source chain's mesh OFT and the transaction is on that chain, the call is `send` (not `quoteSend` / `quoteOFT`, which carry the same `SendParam`), all seven `SendParam` fields are the ones built (`extraOptions`, `composeMsg`, `oftCmd` empty), `MessagingFee.nativeFee` is the sealed fee with `lzTokenFee` 0, and the refund is the sealed refund address; then the pins, the current `quoteSend` (it reverts with `InsufficientCredits` when the pool can no longer pay) within the sealed fee, and `msg.value` = that fee. Its refusals: "usdt0: deposit target … is not the <chain> Legacy Mesh OFT", "usdt0: quote carries no sealed send parameters", "usdt0: quote carries no sealed refund address", "usdt0: the deposit is not the sealed Legacy Mesh send" (undecodable, or `dstEid` / `to` / `amountLD` / `minAmountLD` differ), "usdt0: the deposit calls <function>, not send(SendParam, MessagingFee, refund)", "usdt0: the deposit's SendParam.<extraOptions | composeMsg | oftCmd> <hex> is not the sealed 0x", "usdt0: the deposit's MessagingFee.nativeFee <n> is not the sealed <n>", "usdt0: the deposit's MessagingFee.lzTokenFee <n> is not 0", "usdt0: the deposit refunds <address>, not the sealed refund address <address>", "usdt0: the deposit is for <chain> (chainId <n>), not <chain name> (<CAIP-2>)", then "usdt0: LayerZero fee rose to … — re-quote" and "usdt0: transaction value … is not the quoted fee …". Tracking uses the same LayerZero Scan message; a TON delivery completes only when tonapi (`GET /v2/events/{hash}`, new option `tonApiUrl`, default `https://tonapi.io`) shows the USDT jetton paid to the recipient.
  
  New option `meshDestinations` (provider, `Usdt0Swap2Protocol`, and an optional argument of `usdt0.supportsChain` / `supportsSourceChain` / `supports`): default `["ton"]`, `["tron", "ton"]` adds Tron, `[]` leaves the mesh out. Tron is opt-in because the LayerZero fee into Tron (live 2026-11-12: ≈ 0.0053 ETH from Ethereum / Arbitrum, ≈ 170 CELO from Celo, before headroom) is above the engine's native-fee ceiling in `protocol-swap2-core` (0.005 ETH, 100 CELO), so `swap2` would refuse to execute it; into TON (≈ 0.00007 ETH, ≈ 2.2 CELO sealed) fits. Tron and TON are destinations only: no pair starts there.
  
  Refusal texts are unchanged for every input that was refused before and is not a new route: a Tron / TON source, an EVM source without a mesh OFT (BNB Chain, OP, HyperEVM …) into Tron / TON, and a mesh destination left out of `meshDestinations` still get "USDT0 is not deployed on this chain" from `getQuote`; the first two still get "not a USDT0 route between two deployments" from `usdt0VerifyQuote` (which has no options: it verifies a remote mesh send into either destination). Behaviour changes for existing callers: `supportsChain` is now true for `ton:-239` (with an RPC for any mesh source) and for Celo (a mesh source, with an RPC for Celo), and `usdt0VerifyQuote` holds a route from Ethereum / Arbitrum / Celo into Tron / TON to `usdt0VerifyMeshSend` (an app that runs USDT0 behind `remoteProvider` needs this version on the device to accept mesh quotes; an older client refuses them). New exports: the mesh tables and helpers (`USDT0_MESH_SOURCES`, `USDT0_MESH_DESTINATIONS`, `USDT0_MESH_DEFAULT_DESTINATIONS`, `meshDestinationOn`, `meshRecipientBytes32`, `meshRecipientMatches`, `usdt0VerifyMeshSend`, `usdt0.supportsSourceChain`, type `Usdt0MeshFamily`, …), `TON_API`. `usdt0Pins` now also pins each chain's mesh OFT as call target and spender (Ethereum, Arbitrum, Celo). Existing USDT0 OFT routes quoted with both addresses are unchanged (same intents, amounts, fees and calldata as 0.4.4, checked live on 8 corridors); dry quotes without an address and a zero-address recipient change on every route, see below.
  
  Dry quotes priced for a placeholder carry no transaction, on every route (EVM ↔ EVM OFT sends included), and the zero account is never a recipient. A quote is dry unless `dry: false`; without `destAddress` it was priced — and built — for a stand-in recipient (vitalik.eth between EVM chains, the zero account `T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb` / `0:000…0` into Tron / TON), without `refundAddress` for vitalik.eth as the refund address, and `buildDeposit` and `preflightDeposit` passed that send: an integrator who signed it paid the USDT to vitalik.eth or burned it.
  
  - **Breaking:** a dry quote without `destAddress` or without `refundAddress` comes back as its price only: no `txRequest`, `providerData.placeholder` = `"recipient"` (checked first) or `"refund"` (type `Usdt0Placeholder`, new export), the stand-in's `recipient` / `recipientBytes32` / `refundAddress` removed from `providerData`, the amounts, fee rows and the sealed LayerZero fee (`providerData.nativeFee`) kept. `buildDeposit` refuses it with "swap2: this USDT0 quote was priced for a placeholder recipient | refund address (a dry quote without that address) and has no transaction to build — quote again with the recipient and the refund address", and `preflightDeposit` with "usdt0: this quote was priced for a placeholder recipient | refund address (a dry quote without that address) and has nothing to sign — quote again with the recipient and the refund address", both also with a transaction attached and before any RPC read. What to do: an app that built, signed or showed the transaction of a dry USDT0 quote must name both addresses. The engine's `swap2` is unaffected (it re-quotes live with the account's addresses), and so is `quoteSwap2`'s result. A router's `usdValue` reads the LayerZero fee from `txRequest.nativeFee`, so it no longer nets that fee for such a quote, and `requireImmediateExecution` drops it: pass the account's own address as `recipient` and `refundAddress` for dry previews that need either.
  - **Breaking:** `usdt0VerifyQuote` / `usdt0Pins` (and `usdt0VerifyMeshSend`) refuse a quote that carries a transaction for a dry request without one of the addresses ("a dry quote priced for a placeholder recipient | refund address carries a transaction — it would pay or refund that placeholder, not the wallet that signs it"), and hold the price-only quote to the request: "a USDT0 quote pays no deposit address, but this one names …", "the quote spends …, not the … input", "the quote delivers more than the … input", "the quoted minimum … is below the caller's floor …", "the quote's amounts are not integers", and the existing "the intent id does not name this send". What to do behind `remoteProvider`: bump the server and the app together — an app on 0.4.4 refuses the new server's price-only dry OFT quotes ("the quote carries no OFT call"), and this version refuses a 0.4.4 server's dry OFT quotes that still carry the stand-in's send; either way USDT0 is missing from dry previews until both run this version.
  - **Breaking:** a recipient that is the zero account — EVM `0x000…0`, Tron `T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`, TON `0:000…0` in any spelling (`EQAAAA…M9c`, `UQAAAA…JKZ`) — is refused, dry or live, by `getQuote` (before any RPC read) and by `usdt0VerifyQuote` / `usdt0VerifyMeshSend`: "destination is the zero account — nothing sent there can be recovered"; `preflightDeposit` refuses a quote that seals it with "usdt0: destination is the zero account — nothing sent there can be recovered". Nothing paid there comes back (burned, or a packet stored for good). Accounts next to zero and `0x…dEaD` are quoted as before.
  
  Refusal texts that existed before are unchanged; a live request without a recipient or a refund address is still refused with "a live quote needs a recipient" / "a live quote needs a refund address".

### Patch Changes

- Updated dependencies [b1ac0e3]
  - @anywalletkit/protocol-swap2-core@0.11.0

## 0.4.4

### Patch Changes

- Updated dependencies [6d6e801]
- Updated dependencies [ff6582a]
  - @anywalletkit/swap2-assets@0.3.0
  - @anywalletkit/protocol-swap2-core@0.10.3

## 0.4.3

### Patch Changes

- 69515ec: `module.json` lists all 16 chains the provider routes: Mantle, Morph and Flare were missing from the manifest (and so from the registry) although the provider has carried their deployments since 2026-10-20.

## 0.4.2

### Patch Changes

- Updated dependencies [10e06dc]
  - @anywalletkit/swap2-assets@0.2.3
  - @anywalletkit/protocol-swap2-core@0.10.2

## 0.4.1

### Patch Changes

- @anywalletkit/protocol-swap2-core@0.10.1
  - @anywalletkit/swap2-assets@0.2.2

## 0.4.0

### Minor Changes

- bb7ee2d: USDT0 stored-payload claims now work through `claimSwap2`. When LayerZero stores a delivery that reverted on the destination (`PAYLOAD_STORED`), the provider reports the swap as action-required and builds the `lzReceive` retry on the destination's LayerZero endpoint, but it declared no claim contracts, so `claimSwap2` refused every such claim. The new `usdt0ClaimTargets(chain)` names the destination chain's EndpointV2, and both the provider and `usdt0Pins` carry it. Apps that use a remote USDT0 provider get it by spreading `usdt0Pins` into `remoteProvider({...})` as before; a claim the server points at any other contract is still refused.

### Patch Changes

- Updated dependencies [3b81a37]
- Updated dependencies [b16f9b1]
- Updated dependencies [0919427]
- Updated dependencies [ac56c9b]
- Updated dependencies [21f2b25]
- Updated dependencies [ccea432]
- Updated dependencies [d1e517a]
- Updated dependencies [57a68aa]
- Updated dependencies [5b3e194]
  - @anywalletkit/protocol-swap2-core@0.10.0
  - @anywalletkit/core@0.8.0
  - @anywalletkit/swap2-assets@0.2.2

## 0.3.1

### Patch Changes

- cbd7caa: `usdt0VerifyQuote` binds the tokens the app asked for (re-audit 2026-10-30, #1). It checked the send's amount, eid, recipient and fee, but not the request's tokens, and the OFT spends its own token whatever the request named: a compromised backend could answer "Arbitrum USDC → …" with a valid USDT0 send. Both the source and the destination token must now name the deployment's USDT / USDT0 (contract address or a symbol the catalog does not bind elsewhere), as the local provider already required. Honest USDT0 routes are unchanged.

## 0.3.0

### Minor Changes

- cc09b9f: `usdt0Pins` carry `verifyQuote: usdt0VerifyQuote` (scan 2026-10-30, F3), exported too. The pins named only the OFT, so a compromised backend could answer with a `send` to its own `to`, another eid, a lower `minAmountLD`, its own refund address or extra options, and the engine signed it. The send is now decoded on the device against the app's request: the destination eid, `to` = the recipient, `amountLD` = the input, `minAmountLD` ≤ the input and ≥ the quoted minimum and the caller's floor, empty `extraOptions` / `composeMsg` / `oftCmd`, no LZ-token fee, refund = the trader, `msg.value` = the declared native fee = the call's `nativeFee`, the adapter as spender on Ethereum only. Honest sends are unchanged.

### Patch Changes

- Updated dependencies [9e27fc6]
  - @anywalletkit/protocol-swap2-core@0.9.0

## 0.2.1

### Patch Changes

- Updated dependencies [834c24d]
- Updated dependencies [88a4582]
- Updated dependencies [12fc609]
  - @anywalletkit/core@0.7.0
  - @anywalletkit/protocol-swap2-core@0.8.0
  - @anywalletkit/swap2-assets@0.2.2

## 0.2.0

### Minor Changes

- 418fea1: A remote provider's addresses come from the app, never from its backend. `remoteProvider` takes `callTargets(chain)` / `spenders(chain)` — the provider package's pins, spread in: `lifiPins`, `fyndPins`, `uniswapPins`, `chainflipPins`, `cctpPins` (with its `claimTargets`), `usdt0Pins`, `balancerPins`, `wrapPins` — and an optional `verifyQuote(params, quote)` that runs the provider's own check on the client (`fyndPins` carries `fyndVerifyQuote`: `checkFyndTransaction` against the app's request). The stub is marked `remote: true`; the engine then lets its EVM routes call only pinned targets and approve only pinned spenders. **Fail closed: a remote stub without pins gets no EVM calldata route or approval** — the router and the single-provider path drop such a quote with the reason (`remotePinRefusal`), deposit-address routes need no pins. Wire the pins in every app that proxies providers through `createSwap2Handler`.
  
  For every provider, a token call in a swap's calldata must move the source token, at most the swap amount, to this account, the deposit address of a deposit-address route, or the declared spender (for a remote stub: the pins); `setApprovalForAll` and Permit2 `approve` are never a swap's main call, and `transferFrom` is refused. Before, `{to: USDC, data: approve(attacker, MAX), approvalAddress: attacker}` from a backend, or `cbBTC.transfer(attacker, all)` with `depositAddress = attacker`, passed because the allowlist was the response's own addresses. The router's provider snapshot now keeps the remote marker and the pins (dropped there, execution through the router took a remote stub for a local provider).
  
  **Breaking:** a `remoteProvider` without `callTargets` / `spenders` gets no calldata route on EVM — spread the provider's pins (`lifiPins`, `fyndPins`, …); swap calldata may only move the source token, by at most the input; an operator or Permit2 approval or a `transferFrom` as the swap call is refused. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

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

## 0.1.8

### Patch Changes

- Updated dependencies [b1350b4]
- Updated dependencies [eb14cb5]
  - @anywalletkit/protocol-swap2-core@0.6.1
  - @anywalletkit/core@0.6.1
  - @anywalletkit/swap2-assets@0.2.2

## 0.1.7

### Patch Changes

- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
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

## 0.1.6

### Patch Changes

- e9cc028: A blank `recipient` / `refundAddress` (`""` from an empty input) is treated as omitted: the swap goes to, and refunds to, the account itself, and the review shows that address. CCTP, USDT0 and LI.FI use their placeholder address only for dry quotes; a live quote without a recipient or refund address is refused instead of being built to the placeholder.
- Updated dependencies [6dde4e4]
- Updated dependencies [b08c01a]
- Updated dependencies [e9cc028]
- Updated dependencies [a354990]
- Updated dependencies [0d0e46e]
  - @anywalletkit/swap2-assets@0.2.0
  - @anywalletkit/core@0.5.0
  - @anywalletkit/protocol-swap2-core@0.5.0

## 0.1.5

### Patch Changes

- Updated dependencies [8aa911d]
- Updated dependencies [8aa911d]
- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1
  - @anywalletkit/protocol-swap2-core@0.4.1
  - @anywalletkit/swap2-assets@0.1.5

## 0.1.4

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

## 0.1.3

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2
  - @anywalletkit/protocol-swap2-core@0.3.2
  - @anywalletkit/swap2-assets@0.1.4

## 0.1.2

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [6b164bd]
- Updated dependencies [65c3bca]
  - @anywalletkit/protocol-swap2-core@0.3.1
  - @anywalletkit/core@0.3.1
  - @anywalletkit/swap2-assets@0.1.3

## 0.1.1

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- d08e37e: USDT0 no longer puts raw viem transport errors into refusal reasons or preflight errors. Those errors carry `URL: …`, which includes the key of a keyed RPC.
  
  - **USDT0:** an RPC failure becomes `usdt0: RPC for <chain> unavailable — try again`, and any other text loses its URLs.
  - **swap2-core:** new `redactUrls()`. Servers that forward refusal text to clients should pass it through this.
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

## 0.1.0

### Minor Changes

- 7004ecf: New package: USDT0 — Tether's LayerZero OFT for USDT — as a swap2 provider. USDT / USDT0 between 13 EVM chains (Ethereum adapter, Arbitrum, OP, Polygon, HyperEVM, Ink, Berachain, Unichain, Sei, Plasma, Monad, MegaETH, X Layer) in one source transaction: `quoteOFT` + `quoteSend` on the OFT itself, `send` with the LayerZero fee as `msg.value` (declared as `nativeFee`), approval only for the Ethereum adapter, every deployment bound on-chain (`token()`, `approvalRequired()`, `peers`), preflight against the live fee, status from LayerZero Scan (DELIVERED carries the destination hash), and the `lzReceive` retry of a stored payload as the engine's claim. The asset catalog gains USDT0 on HyperEVM and Unichain.
- 2d6c0f1: USDT0 on Mantle (eid 30181), Morph (30322) and Flare (30295) — 16 deployments, every one re-read on-chain (token, approvalRequired, sharedDecimals, endpoint, Arbitrum peer).

### Patch Changes

- 3ea8e2d: Activity: an OFT `send` folds the LayerZero messaging fee (the native value) into `fee` instead of listing it as an asset the owner swapped away, and names both ends when the calldata carries the destination ("Bridged USDT → USDT0", subtitle "USDT0 · Ethereum → HyperEVM").
- 5c02895: The sealed LayerZero fee carries 25 % headroom over the quote: the fee is paid at send time and moves with gas, so a quote a minute old failed preflight ("fee rose … re-quote"); the endpoint refunds the unused part to the trader in the same transaction. Preflight refuses only a fee past the headroom.
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

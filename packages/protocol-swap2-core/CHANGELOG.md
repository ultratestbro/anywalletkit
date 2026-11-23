# @anywalletkit/protocol-swap2-core

## 0.17.0

### Minor Changes

- 6020956: The router can rank routes net of the source gas (SDK-291). New option `sourceGasUsd` (also on `RouterSwap2Protocol`): the gas a quote's source transaction costs the user in USD, asked once per quote as it arrives and subtracted from its `valueUsd`. `evmSourceGas({prices, rpcUrl})` builds it for EVM sources from the quote (the venue's `txRequest.gasLimit` capped at 3M or 250k, a transfer for a deposit-address route, nothing for a gasless one, plus an ERC-20 approval unless the sender's allowance covers it) at the chain's `eth_gasPrice`. Gas comes off every quote of an auction or none: a quote whose estimate fails or takes over 3 s leaves the auction without gas, as before. `RankedQuote.gasUsd` / `Swap2Route.gasUsd` say what was subtracted. Without `sourceGasUsd` nothing changes.
  
  `Quote.gasless` (protocol-swap2-core): the user signs the source leg and a third party sends it and pays its gas. The swap2 server seals it. Omniston sets it on EVM → TON orders, with the order protocol as `providerData.approvalAddress`.
- ffe1564: Orders that rest before they settle (CoW Protocol), checked at the engine's own gate.
  
  - **A GPv2 typed order is bound to the swap before anything is approved or signed** (`assertGpv2Order`): the GPv2Settlement domain on the source chain, the canonical `Order` type and nothing else, sell token, buy token, receiver, the exact input, a minimum at or above the quoted one, zero signed fee, a sell order with no partial fill and plain ERC-20 balances, an expiry within three hours, and the GPv2 vault relayer as the only spender. An account without `signTypedData` is refused before any approval is sent.
  - **Permit instead of an approval**: a build may offer `permit` (EIP-2612 typed data) and `approvalAmount`. The engine signs the permit only for this account, the source token, the vault relayer, the exact amount and the order's own expiry (`assertGpv2Permit`), hands the signature to the provider's new `applyPermit`, and accepts the returned order only if nothing but `appData` changed. Both fields are refused on anything that is not a GPv2 order; `approvalAmount` must be a finite amount covering the input.
  - **`cancelSwap2(id, account, { onchain? })`** with provider hooks `buildCancel`, `registerCancel`, `cancelTargets`: a typed cancellation is signed only for this account's own order UIDs (`assertGpv2Cancellation`); an on-chain cancel is plain calldata with no value to a contract the provider declared, never a transfer or an approval.
  - `registerSignedOrder` may return `{ intentId }` — the id the placed order is tracked by.
  - Router: the dispatch snapshot carries `applyPermit`, `buildCancel`, `registerCancel` and `cancelTargets`, so a routed order keeps its permit and cancel steps.

## 0.16.0

### Minor Changes

- ef9b9d7: A dry run that fails right after an approval the execution mined is quoted once more on that allowance instead of revoking it (2026-11-19, 0x on Ethereum: the dry run after the mined Permit2 approval reverted, the engine revoked, the user paid two approvals for no swap). Same path as an approval that outlives its quote: same provider, route, spender and amount, the caller's minimum, a second `reviewExecution` with `requoted: true` when the plan changed, phase `requoting`, one re-quote per execution; the allowance is revoked only when that pass fails too. An RPC that does not answer (`upstream_unavailable`) is not re-quoted.
  
  An allowance to canonical Permit2 that the swap spends only as a signature transfer (`PermitTransferFrom`, the 0x Settler) is no longer revoked after a failure: Permit2 moves nothing on it without a fresh signature per transfer, and the revoke cost a transaction, a prompt and the next swap's approval. Every other spender is revoked as before, and so is a Permit2 allowance a route would spend through Permit2's own allowances (`AllowanceTransfer`; no shipped provider does). Messages say which happened ("the Permit2 allowance was left in place").
  
  `simulation_failed` names the revert when the account's error carries revert data (viem's `RpcRequestError.data`, `RawContractError.data`, `ContractFunctionRevertedError.raw`): `(reverted: 0x97a6f3b9 TooMuchSlippage)` — the selector, the name for known 0x Settler / Permit2 / ERC-20 / Uniswap router errors, and an `Error(string)` reason only when it is plain words; never addresses or amounts. A Permit2 execution reports one `signing` phase per pass.

## 0.15.1

### Patch Changes

- 90eebd0: A Permit2 sale that needs an approval asks for the permit once. The engine used to sign the permit before the approvals; when the mined approval outlived the quote (an Ethereum approval against the 0x provider's 45 s TTL), the re-quote carried a new permit and the wallet asked again (permit → approve → permit). With an approval to send, the permit is now signed after it is mined, once the quote is known to be live (re-quoted otherwise) and the provider's preflight passed; one `signing` phase covers the permit and the transaction. With a standing Permit2 allowance the permit still comes first. Trade-off: a permit declined after the approval costs a revoke. An account without `signTypedData` is still refused before any approval.
  
  `zeroExProvider`'s default `quoteTtlMs` is 120 s (was 45 s), still cut to the Permit2 deadline − 20 s for a token sale and to 90 s for a native sale.

## 0.15.0

### Minor Changes

- a096145: Allow `etaSeconds: null` for routes without a defensible delivery estimate. Preserve
  it through remote quote sealing, execution reviews and extension views. The router
  does not award a speed bonus or fastest tag to an unknown ETA; `RouteSet.fastest`
  is nullable and fastest preference falls back to best when every ETA is unknown.
  
  Run the remote provider's client-side build validator again after backend preflight,
  so approvals or review delays cannot bypass fresh client checks before signing.
- eba96eb: Allow provider pins to supply independent client tracking and paid-recovery validation.
  When a remote provider receives a local tracker, it uses that tracker without falling
  back to backend status. Existing providers retain their current tracking behavior.
  
  Stargate's integration now supplies these hooks together with its source-call
  pins, so server/mobile clients can verify payouts and recover pending transfers using
  their own RPC evidence.
- 0d51c25: Add opt-in durable swap operation journals with application-owned atomic storage,
  write-ahead markers around signatures/broadcasts, and read-only reconciliation.
  Ambiguous sends and post-send storage failures cannot authorize automatic retries.
  
  Add separately reviewed, value-bounded EVM recovery with client-side contract pins,
  current on-chain calldata validation and independent recovery transaction tracking.
  Keep existing `awk1` status IDs and zero-value claims compatible.
- fb01615: Support multiple display routes per provider through optional `getQuotes`, stable
  `routeId` selectors, and `using(provider, routeId)`. Validate and rank candidates
  independently while preserving the selected provider, path and caller floor when
  refreshing an expired quote after approval.
  
  Add opt-in remote `/quotes` support (`multiQuotes: true`) with per-candidate validation,
  client checks and sealed route identity. Existing single-quote providers and `awk1`
  tracking IDs remain compatible.

### Patch Changes

- Updated dependencies [0d51c25]
- Updated dependencies [fb01615]
  - @anywalletkit/core@0.9.0
  - @anywalletkit/swap2-assets@0.3.0

## 0.14.0

### Minor Changes

- b7cf66d: `QuoteParams.sender`: the account that signs the source transaction, set by the engine on every execution quote (its own address) and passed through by `createSwap2Handler`; absent on a dry quote. A provider whose deposit gives its sender more than refunds binds to it instead of `refundAddress`, which a caller may set to any address — an Across depositor can sign a speed-up that pays the output to another recipient.

### Patch Changes

- 3bf525f: Fee caps no longer refuse every native-coin input (SDK-318). The engine keyed a native source by its catalog asset id (`nep141:eth.omft.near`, or `""` where 1Click lists no native coin), while providers itemize the native coin as the zero address (Relay, Across), `"native"` (0x, Jupiter) or `0xEeee…EEeE`. So under any `maxNetworkFeeBps` / `maxProtocolFeeBps` every honest native-coin quote was refused with "cannot apply … fee cap across different fee tokens" (nothing was signed, but native routes disappeared for apps that set a cap). When the source is the chain's native coin, those spellings now count as the source: `"native"` on any chain, the zero address and `0xEeee…EEeE` on EVM chains, in any case. Their amounts are added up and held to the cap like any other fee in the source token.
  
  Nothing else is loosened. For an ERC-20 or unlisted source the match is still the exact contract (any case), so a fee named `"native"` or the zero address is another token there. A fee in any other token (an ERC-20, WETH, a bare symbol such as `ETH`, another chain's asset id, Chainflip's `Chain:ASSET`) is still refused, and so is a quote with no itemized fees. Error texts and the `policy_refused` reason are unchanged. `assertFeeCaps` takes an optional fifth argument, `sourceNative`, for subclasses that call it directly. Without it the check is as strict as before.

## 0.13.0

### Minor Changes

- e495f43: The swap engine can pay a swap through a Permit2 signature transfer.
  
  A provider whose router pulls the input with Permit2's `permitTransferFrom` (0x Settler) now sets `txRequest.permit2Transfer`: the JSON EIP-712 `PermitTransferFrom` the account signs for this one swap. The engine never signs that payload as given.
  
  - **The payload is read strictly and rebuilt locally.** `readPermit2Transfer` accepts exactly Permit2's `PermitTransferFrom` (no witness, no extra types or fields) in the Permit2 domain of the source chain, for the source token, for exactly the input amount, with the contract the swap calls as the spender, a uint256 nonce and a deadline no further than an hour away. What goes to `signTypedData` is a payload rebuilt from local constants and the checked values. Anything else is refused before an approval or a signature.
  - **The allowance goes to Permit2 only.** `approvalAddress` must be the canonical Permit2 (`PERMIT2_ADDRESS`). The approval is for exactly the input (USDT reset on mainnet, revoked if the swap does not go out). A standing Permit2 allowance that already covers the input is left as it is.
  - **Signing is typed data only, and comes first.** The account needs `signTypedData`; there is no raw-hash path. The permit is signed before any approval goes out (it needs no allowance), so an account that cannot or will not sign — no `signTypedData`, a declined prompt, a policy refusing the spender — costs no approve-and-revoke. The signature is appended as `calldata ++ uint256(length) ++ signature` (`appendPermit2Signature`), the signed call is estimated from the account once the allowance is in place, and a call that does not simulate is not sent.
  - **The gas limit is the account's own.** The signed call goes out with the account's estimate of exactly that call; a quoted gas limit is not used for it (and is not shown in the plan), so a limit below what the call needs cannot make it revert on-chain after the signature is published.
  - **A dry run tells a revert from a dead RPC.** A signed call that reverts in the dry run is refused as `simulation_failed`, as before. A dry run the account's RPC does not answer (`fetch failed`, a timeout, an HTTP error, a 429) proves nothing about the call: it is asked once more, and then the swap is refused as `upstream_unavailable` ("could not be dry-run: the account's RPC did not answer"), with the allowance taken back as for any refusal there.
  - **No native value rides with a permit.** A quote or build carrying `permit2Transfer` together with a non-zero `value` or `nativeFee` is refused (`policy_refused`): the permitted token is the whole payment.
  - **`CrossChainProvider.ownGasEstimate`.** A provider can declare that every EVM call it builds — a native-coin sale included — goes out like a Permit2 call: dry-run from the account right before the broadcast (refused on a revert, `simulation_failed`; on a silent RPC after one retry, `upstream_unavailable`) and sent with the account's own estimate, never the quoted gas limit, which is then not shown in the plan either. Nothing changes for a provider that does not declare it. The 0x provider does; the router's snapshot carries it.
  - **Addresses in the rebuilt payload are lowercase**, so a provider's mixed-case address with a wrong checksum cannot make the signer throw.
  - **The plan shows it.** `Swap2ExecutionPlan.source` (kind `call`) carries `permit2Transfer` — the exact typed data the account will sign — next to the unsigned calldata.
  - A native-coin input, a typed order next to it, a build that changes the payload, a quote valid past the signature deadline and a token call carrying a permit are refused. A remote stub needs the pinned spender, the pinned target and its own calldata check, as for any other call.
  - The server handler keeps `permit2Transfer` through the quote seal, `build` and `preflight`; `validQuote` requires a string.
  - **Every refusal is classified** (`Swap2RefusalReason`), texts unchanged: a payload naming another contract, domain or allowance target → `vault_mismatch`; another token or amount → `price_check_failed`; a passed deadline → `quote_expired`; a signed call that does not simulate → `simulation_failed`; any other shape (witness, far deadline, native input, a quote outliving its signature, ambiguous payloads) → `policy_refused`. The caller's own malformed expectation and an unusable signature from the account stay unclassified.
  
  New exports (`@anywalletkit/protocol-swap2-core` and `/util`): `PERMIT2_ADDRESS`, `PERMIT2_MAX_DEADLINE_SECONDS`, `PERMIT2_TRANSFER_TYPES`, `readPermit2Transfer`, `permit2TransferJson`, `appendPermit2Signature`, types `Permit2Transfer`, `Permit2TransferExpectation`.

### Patch Changes

- @anywalletkit/swap2-assets@0.3.0

## 0.12.0

### Minor Changes

- fb6ca70: Refusal reasons. Every refusal keeps its text. A classified one also carries `reason`, a `Swap2RefusalReason`:
  `no_route`, `unsupported_pair`, `amount_too_small`, `amount_too_large`, `insufficient_liquidity`, `rate_limited`
  (+ `retryAfterMs`), `key_rejected`, `upstream_unavailable` (+ `httpStatus`), `chain_halted`, `recipient_unverifiable`,
  `recipient_mismatch`, `vault_mismatch`, `stale_node`, `quote_expired`, `price_check_failed`, `simulation_failed`,
  `policy_refused` (`SWAP2_REFUSAL_REASONS`, `isSwap2RefusalReason`).
  
  - Helpers: `refusal(reason, text)` (a plain `Error`), `withReason(err, reason)` (the same error, its class and text
    kept; the first classification stands, and an error whose own `reason` means something else, such as a wallet's
    `SimulationError`, is left alone), `refusalOf(err)` (the error's reason or the first one down its `cause` chain;
    only reasons these helpers stamped count, never another field named `reason` such as a contract's revert text, and
    never on a `Swap2MaybeSentError` chain), `refusalInfo(obj)` (the valid fields of a plain object: a server body, an
    `onRefusal` argument), `httpRefusal(status, retryAfter)`, `parseRetryAfter(header)` (seconds or an IMF-fixdate,
    read without `Date.parse`), `combinedRefusal(refusals)` and `quoteRejection(quote, params, provider)` (why
    `validQuote` refuses: another provider's or input's quote `policy_refused`, a malformed one `upstream_unavailable`,
    under the floor or slippage `price_check_failed`, expired `quote_expired`). The inputs accept an undefined wait or
    status.
  - `Swap2Error` and its subclasses take `reason`, `retryAfterMs`, `httpStatus` and `refusals` in their options
    (`Swap2ErrorOptions`); `code` still names the stage.
  - The engine's "no route available" (`Swap2QuoteError`) carries each venue's refusal in `refusals` and their shared
    reason (else `no_route`), per call (overlapping quotes on one instance keep their own); a provider's `onRefusal`
    info is normalized and cannot rename the venue or rewrite its text; a venue that sat out without a text (disabled: `policy_refused`; not serving the pair:
    `unsupported_pair`; a bare null: `no_route`) is listed with the message unchanged. The engine's own refusals are
    classified: floor and slippage (`price_check_failed`), fee caps and the native fee cap (`policy_refused`), expired
    quotes (`quote_expired`), the build and calldata checks (`policy_refused`, `recipient_mismatch` for a call naming
    another address, `vault_mismatch` for a changed deposit or spender).
  - `onRefusal(text, info?)` gets the classification as a second argument.
  - `createSwap2Handler` adds `reason` / `retryAfterMs` / `httpStatus` to error bodies and `noQuote` (`no_route` for a
    live quote refused without a reason, `quote_expired` for 410, the 502 for a quote the engine would reject by
    `quoteRejection`, a classified refusal thrown from `getQuote` behind the same opaque 500, `policy_refused` for a
    disabled provider's 403, the intent-token 403s and an unsealed quote). `remoteProvider` puts the reason back on the
    thrown error, or takes it from the status (429 → `rate_limited` with Retry-After, 401 / 403 → `key_rejected`,
    408 / 425 / 5xx → `upstream_unavailable`; the status lends its wait and code when the body names the same reason);
    an unreachable backend or a 2xx that is not JSON is `upstream_unavailable`, the caller's own abort is not
    classified, and a `verifyQuote` / `verifyBuild` that throws a classified error keeps its reason. Pins classify their texts
    through the new optional `reasonOf` (`RemotePins`, `RemoteProviderOptions`); `refusalNotes()` keeps that map for
    them, bounded.

## 0.11.0

### Minor Changes

- b1ac0e3: `nativeFeeCeiling` on the engine config (`Swap2EngineConfig`, so on every swap2 protocol and the router): the app's
  own cap for the native fee a route charges on top of the input (a bridge's messaging fee). The engine asks it for every
  execution pass whose quote declares a native fee, before that pass's review and approvals (once, unless the quote
  expires during an approval and the engine re-quotes: the fresh quote is asked again), with
  `{provider, intentId, fromChain, destChain, nativeFee, defaultCap, maxCeiling}` (`Swap2NativeFeeCeilingContext`). A
  non-negative `bigint` is the cap for that execution in place of the chain's own (higher or lower; `0n` refuses any
  fee); `undefined` keeps the chain's cap. Anything else (a number, a string, `null`, a Promise), a throw, or a value
  above `NATIVE_FEE_CEILING_MAX_MULTIPLE` (20) × the chain's cap (0.1 ETH on Ethereum and the ETH-denominated L2s,
  2000 CELO on Celo) refuses the execution with a `Swap2ConfigurationError` ("swap2: nativeFeeCeiling returned … not a
  non-negative bigint or undefined", "… threw for …", "… above the hard maximum …"); no answer removes the cap. A fee
  above the chosen cap is refused with the existing text ("swap2: quoted native fee <fee> exceeds the cap <cap> for
  <chain>"). Without the hook nothing changes: same caps, same texts.
  
  It lets an app run USDT0 Legacy Mesh into Tron, whose LayerZero fee (0.005341 ETH / 170.5 CELO on 2026-11-12, 0.006676
  ETH / 213.1 CELO with the provider's 25 % headroom) is above the default caps, without raising them for every route:
  match provider `"usdt0"`, destination `"tron:728126428"` and the Tron eid 30420 in the intent id
  (`usdt0-mesh:<srcEid>:30420`), and name 0.01 ETH for Ethereum and Arbitrum and 300 CELO for Celo. Only execution
  applies a native-fee cap: `quoteSwap2` and the router's route list do not, as before.

## 0.10.3

### Patch Changes

- ff6582a: Native-fee ceiling for Elysium (`eip155:99901`): 0.1 HYPE, as on HyperEVM. Elysium pays gas in HYPE, so the 0.005 default for ETH-denominated chains (≈ $0.37 in HYPE) would have refused ordinary bridge fees on routes out of Elysium.
- Updated dependencies [6d6e801]
  - @anywalletkit/swap2-assets@0.3.0

## 0.10.2

### Patch Changes

- Updated dependencies [10e06dc]
  - @anywalletkit/swap2-assets@0.2.3

## 0.10.1

### Patch Changes

- Updated dependencies [543598d]
  - @anywalletkit/tx-preview-evm@0.5.1
  - @anywalletkit/swap2-assets@0.2.2

## 0.10.0

### Minor Changes

- 3b81a37: A CCTP swap claimed through `claimSwap2` reaches `completed` again without an RPC for the destination chain, when the destination account proves the claim.
  
  - `claimSwap2` already waits for the claim with the account's `waitForTransaction`. When that wait resolves (the claim was included and succeeded), the id it returns now ends in `.ok` after the claim hash: `awk1.<provider>.<intent>.<sourceTx>.<claimTx>.ok`. Polling that id passes the new `IntentRef.destTxConfirmed: true` to the provider (a remote backend forwards it too).
  - The CCTP provider takes a confirmed claim as the mint, since `receiveMessage` reverts once the message's nonce is used: `completed` without a destination RPC. With a destination RPC that does not show the mint yet, it reads `pending` (claim not ready) instead of offering the claim again.
  - A bare claim hash (an account without `waitForTransaction`, or a wait that timed out) still proves nothing and stays `pending` until the destination's `usedNonces` shows the mint.
  - `parseSwapId` (extension kit) reads the `.ok` segment as `destTxConfirmed`.
  
  What to do: keep polling with the id `claimSwap2` returns (store it in place of the old one), and give the destination account `waitForTransaction` (the SDK's EVM accounts have it). If you parse swap ids yourself, accept a fifth segment `ok`. An RPC for each destination in `rpcUrls` is still the way to see a claim sent from elsewhere complete.
- b16f9b1: A Mayan bridge order out of Solana must now deliver what was reviewed, not only name the reviewed recipient and chain.
  
  - `wallet-solana`: with `expect.bridgeOut`, every Mayan Swift / MCTP / Fast MCTP order must carry a non-zero minimum, a referrer or Mayan fee rate of at most `MAYAN_REFERRER_FEE_MAX_BPS` (50 bps) and fixed relayer fees (Swift submit / cancel / refund, the MCTP order modes' redeem / Solana / refund / Circle fees) of at most `MAYAN_RELAYER_FEE_MAX_BPS` (10 %) of its input. `BridgeOutExpectation` gains `destToken`, `minAmountOut` (bigint, with `destDecimals`) and `slippageBps`: an order's output token must be `destToken` (`bridge-token`) and its own minimum — Swift's `amountOutMin` at Mayan's 8 decimals, or for a plain MCTP / Fast MCTP USDC bridge the bridged amount less its fees — at least `minAmountOut` less 1 bp of rounding (`bridge-min`; `minAmountOut` already is the minimum at the plan's slippage, so `slippageBps` is not taken off it again). Every recorded LI.FI Mayan answer passes.
  - `protocol-swap2-core`: the engine's `bridgeOut` now also carries `destToken`, `minAmountOut` (the quote's minimum, a base-unit string), `destDecimals` (the catalog's, else the caller's verified `toTokenDecimals`) and `slippageBps` (when the caller set a slippage).
  
  What to do: an app that maps the engine expectation onto `account.sendSerialized` itself forwards the new fields too, with `minAmountOut` as a bigint and only together with `destDecimals` (a string, or `minAmountOut` without `destDecimals`, is refused as `invalid-expectation`).
- 0919427: A bridge leg's reviewed minimum is no longer held in decimals that only the provider reported.
  
  - `core`: `Swap2Options` gains an optional `toTokenDecimals`, the decimals of `toToken` on the destination chain when the swap catalog does not list it, as the app verified them.
  - `protocol-swap2-core`: the engine's `bridgeOut.destDecimals` is the asset catalog's value, else the caller's `toTokenDecimals`. A quote's `destDecimals` (for example LI.FI's `action.toToken.decimals`) is no longer used on its own. When both are present and disagree, the swap is refused before anything is signed. A `toTokenDecimals` that is not a whole number in 0..36 is refused. Catalog-listed destination tokens work as before and ignore `toTokenDecimals`.
  
  What to do: for a swap to a destination token the catalog does not list (for example a token the user added by address), read its decimals on the destination chain (`getTokenInfo` on that chain's account, or `inspectToken` from `@anywalletkit/tokens`) and pass them as `toTokenDecimals`. Without them, a Mayan bridge out of Solana to that token has no reviewed minimum and wallet-solana refuses it at signing (`bridge-min`). Other bridges and all catalog-listed routes are unaffected.
- ac56c9b: A Mayan bridge order out of Solana is now always held to a reviewed token and minimum.
  
  - `protocol-swap2-core`: `Quote` gains an optional `destDecimals` (the destination token's decimals as the provider reports them). The swap2 server seals it (a whole number in 0..36; anything else is refused like any malformed quote field). The engine's `bridgeOut.destDecimals` uses the asset catalog's decimals, else the caller's verified `toTokenDecimals` (which the quote's value must agree with), never the quote's alone.
  - `protocol-swap2-lifi`: quotes carry `destDecimals` from LI.FI's `action.toToken.decimals`.
  - `wallet-solana`: with `expect.bridgeOut`, a Mayan order is refused when the guard names no `destToken` (`bridge-token`) or no `minAmountOut` with `destDecimals` (`bridge-min`), instead of passing with only its own non-zero minimum.
  
  What to do: nothing when you map the engine's expectation with `serializedGuardFromExecution`. A hand-built `bridgeOut` for a Mayan route must now carry `destToken`, `minAmountOut` and `destDecimals`. A swap to a destination token the catalog does not list through Mayan needs `toTokenDecimals`, or the leg is refused at signing.
- d1e517a: Bridges out of Solana are now bound to the recipient you reviewed, not only to a SOL-out ceiling.
  
  - `protocol-swap2-core`: for a cross-chain serialized leg the engine adds `bridgeOut: {destChain, recipient}` to the expectation it hands `account.sendSerializedTransaction`.
  - `wallet-solana`: `sendSerialized` / `checkSerialized` accept `expect.bridgeOut` (`BridgeOutExpectation`). When the transaction is a Mayan route (it runs one of Mayan's own programs, directly or through Mayan's CPI proxy), every top-level instruction must be one the guard can follow — transfers to this wallet's own accounts or to a fee wallet (LI.FI's `LIFI_FEE_WALLET_ADDRESS` by default, at most 3 % of what may leave), a Jupiter swap into the wallet or the bridge, Mayan's Swift / MCTP / Fast MCTP orders — and every Mayan order must pay `recipient` on `destChain`; otherwise the wire is refused with `bridge-recipient`, `bridge-payee`, `bridge-instruction`, `bridge-missing` or `bridge-fee`. A transaction of another bridge is checked as without `bridgeOut` (see the Solana-bridges note). Instructions sent through Mayan's CPI proxy (`MAYAN_CPI_PROXY_PROGRAM_ADDRESS`) are now described and guarded as the instruction they run, so a program allowlist and the core-instruction checks see through it; the legacy empty-data ATA Create is described as an ATA creation.
  - `protocol-swap2-lifi`: the provider and `lifiVerifyQuote` refuse a Solana bridge transaction that is not paid by the sender, or a Mayan route that transfers SOL directly to a wallet other than the sender or LI.FI's fee wallet.
  
  What to do: map the swap2 expectation onto `account.sendSerialized` with `serializedGuardFromExecution` from `wallet-solana` (see the note on it) instead of by hand. Without `bridgeOut` the account cannot prove where a Mayan bridge pays.
- 57a68aa: A CCTP claim hash is no longer taken as proof that the USDC was minted when the destination can be checked.
  
  - `cctpProvider`: when a destination RPC is configured but the `usedNonces` read fails (or the attested message carries no nonce to read), a swap with a recorded claim hash now reports `pending` (the claim hash is kept in `transactions`) instead of `completed`. Poll again; it completes once the RPC answers and the nonce is used. Without any destination RPC the recorded claim hash is still the evidence, as before.
  - `claimSwap2` (all two-phase providers): when the destination account has `waitForTransaction`, the engine now waits for the claim before returning. If the wait proves the claim reverted on chain (the account's error has `code: "reverted"` or says the transaction reverted, as `@anywalletkit/wallet-evm` does), `claimSwap2` throws `Swap2ExecutionError` (claim hash in the message, the account's error as `cause`) and returns no id that carries the claim hash; poll the swap's status with the id you already had and claim again if it is still `action-required`. A wait that times out or loses the RPC proves nothing: the id with the claim hash is returned as before, and the provider's status decides (for CCTP with a destination RPC, `pending` until the mint is seen). Accounts without `waitForTransaction` behave as before.

### Patch Changes

- 21f2b25: `wallet-solana` now exports `serializedGuardFromExecution(expect, extra?)` (and the `SerializedExecutionInput` type): it turns the expectation the swap2 engine hands an account's `sendSerializedTransaction(serializedTx, expect)` hook into the guard for `sendSerialized` / `checkSerialized`, carrying every field — `maxValueOut` → `maxLamportsOut`, `tokenIn`, `source` → `maxTokenOut`, and `bridgeOut` with its reviewed `destToken`, `minAmountOut` (as a bigint, only with `destDecimals`) and `slippageBps`. `extra` adds guard options such as a program allowlist. The engine sets `bridgeOut` on every cross-chain serialized leg; a guard without it still behaves as before (SOL ceiling and token bounds only), so an adapter that drops it leaves a bridge's recipient unchecked.
  
  What to do: replace a hand-written mapping with the helper, for example in an account adapter:
  
  ```ts
  sendSerializedTransaction: (tx, expect) => solanaAccount.sendSerialized(tx, serializedGuardFromExecution(expect))
  ```
- ccea432: A quote whose minimum sits exactly at the requested slippage is no longer refused for a rounding difference. Providers compute their minimum with their own rounding — LI.FI's Mayan answers land a few base units under floor(output × (1 − slippage)) on 18-decimal tokens — so the LI.FI provider's per-step check, `validQuote` (router, single-provider path, server) and the engine's caller-slippage check refused about half of the Mayan routes out of Solana at the default 0.5 % as "0.50 % under the quote". All three now accept a minimum up to the requested slippage plus 1 bp (`SLIPPAGE_ROUNDING_BPS`, and `slippageFloor(dest, bps)` in `@anywalletkit/protocol-swap2-core/validate`); a minimum further under the quote is still refused. Nothing to change in apps.
- 5b3e194: Copies no longer turn an own `"__proto__"` key into a prototype. The Hermes `structuredClone` polyfill (installed only when the runtime has no native one) and the swap2 review copy assigned keys one by one, so an object parsed from JSON with a `"__proto__"` key came out with that object as its prototype and inherited fields from it. The key is now kept as an own property, as the native `structuredClone` does; cycles and shared references are kept as before. Nothing to change in your app.
- Updated dependencies [d6632b9]
- Updated dependencies [0919427]
- Updated dependencies [02aa3f6]
- Updated dependencies [89c4ad1]
- Updated dependencies [1de4a34]
  - @anywalletkit/tx-preview-evm@0.5.0
  - @anywalletkit/core@0.8.0
  - @anywalletkit/swap2-assets@0.2.2

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

- First versioned release of the SDK: every package leaves 0.0.1 / its earlier 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`anywalletkit` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @anywalletkit/core@0.1.0
  - @anywalletkit/swap2-assets@0.1.0
  - @anywalletkit/tx-preview-evm@0.1.0

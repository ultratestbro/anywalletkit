# @anywalletkit/protocol-swap2-0x

## 0.2.0

### Minor Changes

- 657011c: Monad (`eip155:143`) joins the default chain table: Settler registry `0x00000000000004533Fe15556B1E086BB1A72cEae`, taker Settlers 12 `0xF16D1df42E368e4dd873b1f92ED0670FF4c987eB` (current) and 11 `0x031D28683fFc9936903a31670bC618b8Bc9b65dD` (previous), canonical Permit2, WMON `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A`; watched like the other chains and covered by `verify:live`. Every chain's `prev(2)` is now watched too, and the Settler in force (`ownerOf(2)`) is a severity-high watch source: a new deployment on a pinned chain refuses native-coin sales from that day. Apps that passed Monad through `chains` can drop the override; Monad swaps are now labelled in activity history. Monad is served by default from 0.2.0: give `rpcUrls[143]` on the backend and in the app (without it, live Monad quotes are refused with "no RPC is configured for chain 143" while indicative ones still go out, so the router can show 0x on a Monad route it then cannot quote), or pass `chains: { 143: null }` to keep it off. Monad bills the gas limit, not the gas used, and its gas grows with the size of the sale (0x splits a large one across many pools: in the 2026-11-26 recordings a $1–25 swap took about 1.6 times Base's gas, 62,000 MON → AUSD 3,970,462 and 1,000,000 MON → AUSD 6,140,730): under one 6,000,000 cap on the padded gas limit (0x's gas × 1.2 + 20,000) for every chain, live 0x sales of MON were refused from about $10,000 on 2026-11-26 (for 1,000,000 MON 0x asked for 5.0–6.1 million), with sales from about $1,600 up at 82–93 % of the cap.
  
  The gas cap is per chain. A chain table entry may carry its own `maxGasLimit`, a bigint from 1 to 30,000,000 (Monad's per-transaction gas limit; anything else throws, so config can raise a chain's cap but not remove the bound). Monad's default entry sets 15,000,000 (0x asking for at most 12,483,334); every other chain keeps 6,000,000 (`ZEROEX_MAX_GAS_LIMIT`, 0x asking for at most 4,983,334). The provider, the remote verifiers (`zeroExVerifyQuote`, `zeroExVerifyBuild`), `checkZeroExTransaction` and now `zeroExPreflightDeposit` hold a quote's gas limit (the padded limit of 0x's `transaction.gas` when 0x states it as a decimal string; a quote that does not carries no limit, and none is ever sent) to its chain's cap, and the refusal names the chain and the cap (`zeroex: the transaction asks for more gas than any 0x swap needs (its gas limit must be 1 to 15000000 on chain 143)`; the text of this refusal changed on every chain, its reason is still `policy_refused`). Every 0x call still goes out with the account's own estimate, never the quoted limit, so the cap only decides which quotes are refused. An entry passed through `chains` replaces the default whole: a Monad entry of your own without `maxGasLimit` has the 6,000,000 cap. New exports: `ZEROEX_GAS_CAP_CEILING`, `isZeroExGasCap`, `zeroExMaxGasLimit` and `checkZeroExGasLimit`.
  
  Activity labelling reads the chain table the provider was built with (`zeroExProvider` / `zeroExRemoteProvider`, `chains`), not only the defaults, so a chain added or re-pinned through `chains` is labelled too; `describeZeroExActivity(tx, ctx, chains?)` takes the table as an optional third argument.
  
  `verify:live`: a chain no RPC answers fails the run (it printed `ok — no RPC for …` before), Monad has a public endpoint, `RPC_<chainId>` may list a fallback (`url,url`), a read the RPC did not answer (a JSON-RPC error that is not a revert — a revert is code 3 or "execution reverted…", so neither a rate limit nor a gateway's "request reverted by gateway" is one —, an answer for another chain, or no code at the pinned registry, an RPC with no state) is retried on the next endpoint instead of being read as the registry's word, a registry that names no Settler is read again before it is reported (up to three tries: on another endpoint, or on the same one when every other failed) until a second answer names none too — only when no other read answers does the one reading stand —, what `ownerOf(2)` / `prev(2)` named is kept when a later read of the same try gets no answer (a new deployment is still reported as NEW, with its severity, not as unreachable), `ownerOf(2)` reads that disagree print a `note chain …` line (the canary counts it as a warning), a failed read prints its JSON-RPC code and a fixed class rather than the RPC's own message, and a failed run ends with `Severity: high` (when a sale through the Settler in force is refused today: what is refused and why, per chain; on a deployment day 0x keeps quoting the previous Settler for a while — on 2026-11-26 it quoted prev(2) on all eight chains — and a native-coin sale to it still passes, which the line says) and a `Reason:` line that names every chain that is not ok (`Reason: NEW on 1, 8453; unreachable on 143`). With `ZEROEX_API_KEY` it also quotes Monad MON → AUSD (100 MON, native) and USDC → MON (Permit2). Apart from the gas cap, no runtime check changed. Recorded 0x answers now cover the pin era in force (2026-11-25) on all eight chains, Monad's first among them: 27 answers made on 2026-11-26 with a 0x API key (read-only, the key in no recording), a native-coin sale, a token sale and an indicative price per chain, plus Monad MON → AUSD at 62,000 and 1,000,000 MON; the registry still named exactly the era's pins, and 0x quoted the previous Settler (`prev(2)`) on every chain. They replay through every check like the 2026-11-15 set, `fixtures/pin-eras.json` lists no era and no chain as unrecorded, and a test holds both lists empty, so every era and every chain of the table must have its recordings.

## 0.1.6

### Patch Changes

- cf4b9db: Settler pins raised to the deployments 0x made on 2026-11-24 (0x-settler release 2026-11-24) on every chain: Ethereum 22/21, Optimism 22/21, BNB Smart Chain 24/23, Polygon 21/20, Base 23/22, Arbitrum 21/20, Avalanche 21/20 (`newestLiveNonce` / `previousLiveNonce`, read from the registry's `ownerOf(2)` / `prev(2)` on 2026-11-25 and checked by `verify:live`). Since 2026-11-24 the 0.1.5 table refuses native-coin sales to the new Settlers on all seven chains (`vault_mismatch`, "newer than the newest one live when this module's chain table was pinned"); token sales use them inside the margin. On 2026-11-26 0x still quoted the previous Settlers, which 0.1.5 accepts: this patch is ready for the moment 0x moves its quotes to the new ones. In remote mode the app checks quotes against its own table, so ship 0.1.6 in the app as well as on the backend. No check changed.

## 0.1.5

### Patch Changes

- Updated dependencies [6020956]
- Updated dependencies [ffe1564]
  - @anywalletkit/protocol-swap2-core@0.17.0

## 0.1.4

### Patch Changes

- Updated dependencies [ef9b9d7]
  - @anywalletkit/protocol-swap2-core@0.16.0

## 0.1.3

### Patch Changes

- 90eebd0: A Permit2 sale that needs an approval asks for the permit once. The engine used to sign the permit before the approvals; when the mined approval outlived the quote (an Ethereum approval against the 0x provider's 45 s TTL), the re-quote carried a new permit and the wallet asked again (permit → approve → permit). With an approval to send, the permit is now signed after it is mined, once the quote is known to be live (re-quoted otherwise) and the provider's preflight passed; one `signing` phase covers the permit and the transaction. With a standing Permit2 allowance the permit still comes first. Trade-off: a permit declined after the approval costs a revoke. An account without `signTypedData` is still refused before any approval.
  
  `zeroExProvider`'s default `quoteTtlMs` is 120 s (was 45 s), still cut to the Permit2 deadline − 20 s for a token sale and to 90 s for a native sale.
- Updated dependencies [90eebd0]
  - @anywalletkit/protocol-swap2-core@0.15.1

## 0.1.2

### Patch Changes

- Updated dependencies [a096145]
- Updated dependencies [eba96eb]
- Updated dependencies [0d51c25]
- Updated dependencies [fb01615]
  - @anywalletkit/protocol-swap2-core@0.15.0
  - @anywalletkit/core@0.9.0

## 0.1.1

### Patch Changes

- Updated dependencies [3bf525f]
- Updated dependencies [b7cf66d]
  - @anywalletkit/protocol-swap2-core@0.14.0

## 0.1.0

### Minor Changes

- 58a7bf5: New package: 0x Swap API v2 as a same-chain swap2 provider through the Permit2 flow, exact input on Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche and BNB Smart Chain, written from the 0x API and the Settler contracts with no 0x package. The key stays on a server (`zeroExProvider`, a getter or a string, sent only as a header; redirects refused, and an answer that came through one anyway or from another origin is not used; under React Native a provider with a key refuses to be built); the app runs `zeroExRemoteProvider`, which re-checks every quote and build on the device, each live quote against exactly the Settler set its own request read. The Settler is read from 0x's on-chain registry over the app's own RPC and must be a CREATE3 deployment of that registry between the deployments the chain table pins as previous and current when pinned (`previousLiveNonce`, `newestLiveNonce`; token sales also up to `ZEROEX_SETTLER_NONCE_MARGIN` newer ones), with contract code at the address — a native-coin sale goes only to the two pinned Settlers; a newer deployment is refused with what to do, and the watch job and `verify:live` report each one; in remote mode the device reads the registry again before the backend's preflight, and a native sale's quote stays valid for at most two minutes; the Permit2 payload is rebuilt on the device (exact input, that Settler as spender, at most ten minutes); the call's target, value, recipient, buy token and minimum are read from the Settler calldata, and its first action must spend exactly that permit (a native sale's must be `NATIVE_CHECK`). Native sales take 0x's Permit2 `allowanceTarget` and approve nothing. Every call goes out with the account's own gas estimate, dry-run first (`ownGasEstimate`). Fees are shown or the quote is refused; an integrator fee nobody asked for, or an excluded source 0x does not know, refuses it. Every refusal has a `Swap2RefusalReason` (`onRefusal`, `zeroExPins.reasonOf`). `zeroExKnownSpenders(provider, chainId)` gives signing policies the Settlers in force as `knownSpenders`. Tested on recorded real answers from all seven chains; `verify:live` checks the registry, the Settlers and Permit2 on chain and, with a key, live corridors.

### Patch Changes

- Updated dependencies [e495f43]
  - @anywalletkit/protocol-swap2-core@0.13.0

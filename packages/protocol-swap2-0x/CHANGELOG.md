# @anywalletkit/protocol-swap2-0x

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

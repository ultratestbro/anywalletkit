# @anywalletkit/protocol-swap2-symbiosis

## 0.1.2

### Patch Changes

- 8f23c02: Refusal reasons. Every refusal keeps its text; `getQuote` passes the classification to `onRefusal` as its second
  argument, and the errors thrown by `buildDeposit`, `preflightDeposit`, `symbiosisTronCall`, `checkSymbiosisCall` and
  `checkSymbiosisTonMessage` carry it (`refusalOf`). The API: 429 `rate_limited` with Retry-After, 401 / 403
  `key_rejected`; otherwise what its message says ("Price impact is too high" `price_check_failed`, a throttle
  `rate_limited` with the Retry-After header's wait, a message naming the API key or partner id `key_rejected`, "This
  swap is not available" and other no-route wording `no_route` — except on a 5xx, where it stays the venue failing — an
  amount under its minimum or the fee `amount_too_small`, above its maximum `amount_too_large`, liquidity
  `insufficient_liquidity`, paused or maintenance `chain_halted`), else 5xx `upstream_unavailable` with `httpStatus`, else
  a quote request refused with 400 / 422 `no_route` and any other failed request (another 4xx, a refused limits read)
  `upstream_unavailable` with `httpStatus`; a network failure, the module's own timeout, unreadable limits and an answer
  with missing or malformed fields, transaction or TON message `upstream_unavailable`. A gateway's "Service Unavailable"
  or a bare "Forbidden" / "Unauthorized" is not read as an answer about the pair or the key. The caller aborting while
  the limits are read stays unclassified. The module's own checks: flexible amounts, an
  unwired chain, same-chain, a Bitcoin destination, an uncatalogued token, TON's native coin and Tron ↔ TON without
  `fallbackReceiver` `unsupported_pair`; Tron / Bitcoin sources switched off, `boundSourceOnly`, a transaction for another
  chain, a Tron call that is not `metaRoute` or for another owner, a Tron fee limit above the ceiling, a build that
  differs from the quote and a quote without its sealed request or transaction `policy_refused`; a zero amount and the
  limits' minimum `amount_too_small`, their maximum `amount_too_large`; an address of the wrong format
  `recipient_mismatch`; partner routes `recipient_unverifiable`; another output token, an unusable output and the
  caller's floor `price_check_failed`; an approval of another spender `vault_mismatch`; an expired quote
  `quote_expired`. The calldata checks (`symbiosisInspectQuote`, `symbiosisVerifyQuote`, `symbiosisVerifyBuild`): a
  gateway, Portal, Bridge, Synthesis, MulticallRouter, pool, router or spender off the pins `vault_mismatch`; a credit,
  burn, unwrap, swap, excess or revert address that is not the user's `recipient_mismatch`; a minimum below the quote's
  and another output token `price_check_failed`; a fee that takes the whole amount `amount_too_small`; calldata that does
  not decode canonically, amounts or values off the request and every other shape the module never signs
  `policy_refused`. `symbiosisPins` / `symbiosisPinsFor` gain `reasonOf`, so a remote stub's "fails this app's own check"
  error carries the reason. Option checks, an invalid amount or slippage, a live quote without addresses, an unexpected
  exception and the caller's own abort stay unclassified.
- Updated dependencies [fb6ca70]
  - @anywalletkit/protocol-swap2-core@0.12.0

## 0.1.1

### Patch Changes

- Updated dependencies [b1ac0e3]
  - @anywalletkit/protocol-swap2-core@0.11.0

## 0.1.0

### Minor Changes

- ddab8aa: New swap2 provider: Symbiosis. Cross-chain swaps between Ethereum, BNB Chain, Avalanche, Polygon, Arbitrum, Optimism, Base, Tron and TON through Symbiosis' public REST API, with TON jettons and (opt-in, `tronSource`) Tron TRC-20 as sources. The source transaction is decoded on the device at every level — the MetaRouterGateway call, the bridge request, the host-chain pool swaps and the destination call — and bound to the request against pinned contracts, pools and synthetic tokens before a quote is shown and again before signing; legs on venues the module cannot read are asked for again without them or refused. Every reported fee is on the quote, the API's limits are enforced locally, and the status mapping reports a refund only with the revert transaction. Bitcoin sources (API-assigned deposit address) are opt-in behind `btcSource` and `depositAddressRoutes`.

### Patch Changes

- Updated dependencies [6d6e801]
- Updated dependencies [ff6582a]
  - @anywalletkit/swap2-assets@0.3.0
  - @anywalletkit/protocol-swap2-core@0.10.3

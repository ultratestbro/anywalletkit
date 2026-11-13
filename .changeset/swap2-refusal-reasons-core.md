---
"@anywalletkit/protocol-swap2-core": minor
---

Refusal reasons. Every refusal keeps its text. A classified one also carries `reason`, a `Swap2RefusalReason`:
`no_route`, `unsupported_pair`, `amount_too_small`, `amount_too_large`, `insufficient_liquidity`, `rate_limited`
(+ `retryAfterMs`), `key_rejected`, `upstream_unavailable` (+ `httpStatus`), `chain_halted`, `recipient_unverifiable`,
`recipient_mismatch`, `vault_mismatch`, `stale_node`, `quote_expired`, `price_check_failed`, `simulation_failed`,
`policy_refused` (`SWAP2_REFUSAL_REASONS`, `isSwap2RefusalReason`).

- Helpers: `refusal(reason, text)` (a plain `Error`), `withReason(err, reason)` (the same error, its class and text
  kept; the first classification stands, and an error whose own `reason` means something else, such as a wallet's
  `SimulationError`, is left alone), `refusalOf(err)` (the error's reason or the first one down its `cause` chain),
  `httpRefusal(status, retryAfter)`, `parseRetryAfter(header)` (seconds or an IMF-fixdate, read without `Date.parse`)
  and `combinedRefusal(refusals)`.
- `Swap2Error` and its subclasses take `reason`, `retryAfterMs`, `httpStatus` and `refusals` in their options
  (`Swap2ErrorOptions`); `code` still names the stage.
- The engine's "no route available" (`Swap2QuoteError`) carries each venue's refusal in `refusals` and their shared
  reason (else `no_route`); a venue that sat out without a text (disabled: `policy_refused`; not serving the pair:
  `unsupported_pair`; a bare null: `no_route`) is listed with the message unchanged. The engine's own refusals are
  classified: floor and slippage (`price_check_failed`), fee caps and the native fee cap (`policy_refused`), expired
  quotes (`quote_expired`), the build and calldata checks (`policy_refused`, `recipient_mismatch` for a call naming
  another address, `vault_mismatch` for a changed deposit or spender).
- `onRefusal(text, info?)` gets the classification as a second argument.
- `createSwap2Handler` adds `reason` / `retryAfterMs` / `httpStatus` to error bodies and `noQuote` (`no_route` for a
  live quote refused without a reason, `quote_expired` for 410, `policy_refused` for a disabled provider's 403 and an
  unsealed quote). `remoteProvider` puts the reason back on the thrown error, or takes it from the status (429 →
  `rate_limited` with Retry-After, 401 / 403 → `key_rejected`, 408 / 425 / 5xx → `upstream_unavailable`); an
  unreachable backend is `upstream_unavailable`, the caller's own abort is not classified. Pins classify their texts
  through the new optional `reasonOf` (`RemotePins`, `RemoteProviderOptions`); `refusalNotes()` keeps that map for
  them, bounded.

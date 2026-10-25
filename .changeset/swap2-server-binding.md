---
"@anywalletkit/protocol-swap2-core": minor
---

`createSwap2Handler` binds quotes and swaps to the caller (audit 2026-10-25, finding 12). A sealed quote and an intent id used to be good for any caller: one user could build another's quote, and anyone could ask about any swap (deposit addresses are public on chain), notify it or register against it.

- Every quote's `intentId` leaves with an intent token appended (`<id>~<tag>`, HMAC under `sealSecret`); `track`, `claim`, `notify` and `register` refuse an id without a valid token (403), and the provider only ever sees its own id. The app, `remoteProvider` and the swap2 engine need no change: the swap id the engine hands out carries the token.
- New `subject(context)`: the authenticated user (the Sign-In with Ethereum address, not an email). Quotes are sealed for it and tokens issued to it, so another user's quote or swap id is refused (403). Without it the token is a bearer capability for that one swap.
- New `acceptUntokenedTrackUntil`: while moving from another backend, `track` (read-only) accepts ids without a token until that time.
- `guard` now runs after validation and receives the validated request (`call.request`, with the provider's own intent id), so limits can depend on what is asked.

---
"@anywalletkit/wallet-evm": minor
---

"nonce too low" is re-signed only when the nonce is proven taken by another transaction (scan 2026-10-30, F1). After the node refused a send with "nonce too low" and said it never saw the hash, the account signed the same payload again with the next nonce — but that RPC already held the first signed bytes, so a malicious RPC could broadcast both. Now the account asks every distinct configured endpoint directly: it signs again only when at least two of them count the account's mined transactions past the nonce and none knows the first hash (any endpoint that knows it ends the send as accepted). Otherwise the send throws the new `NonceConflictError` (extends `BroadcastUnknownError`: `maybeSent`, `hash`, plus `nonce` and `nextNonce`) and the account's next send skips the refused nonce.

**Breaking:** with one RPC configured, a stale `pending` nonce is no longer recovered silently — the send throws `NonceConflictError` and the caller's retry goes through. Show "the network didn't confirm — check activity, then retry". Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

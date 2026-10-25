---
"@anywalletkit/extension-kit": patch
---

Security fixes from the 2026-10-25 audit.

- **A lock is never undone.** A `touch()` that read the session record before a `lock()` removed it wrote it back afterwards, leaving the wallet unlocked. `unlock` / `lock` / `touch` / `getKey` / `isUnlocked` now run one at a time, and a touch writes only when no lock happened since its read.
- **Parallel writes keep every change.** `setSecret`, `deleteSecret`, `addPasskey`, `removePasskey`, `changePassword`, the v1 → v2 upgrade on `unlock`, `create` and `destroy` were read-modify-write without a lock, so two imports at once lost a secret. They are serialized per `Vault` (keep one `Vault` per storage area).
- **Internal errors stay internal.** `toRelayError` passed any error's message to the dApp page, and viem's messages carry the RPC URL (often with the provider key) and the request body. It now passes `RouterError`, `ReviewDeclined`, a core `UserRejectedError` (4001) and a node's JSON-RPC error (code, node message, revert data) with URLs removed; everything else is `-32603 Internal error`, with the error handed to the new `options.log`.
- **Bounded KDF and envelope.** An envelope could ask for any scrypt cost or PBKDF2 iteration count, so an edited vault hung or crashed the worker on unlock. New `VAULT_LIMITS` (scrypt N ≤ 2^20, r ≤ 16, p ≤ 4; ≤ 5 000 000 iterations; ≤ 1 000 secrets of ≤ 16 KiB, ≤ 32 passkeys, ≤ 4 MiB envelope) are checked before any KDF runs (`unsupported-envelope`), by the constructor for its options, and before every write.

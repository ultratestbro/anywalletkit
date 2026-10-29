---
"@anywalletkit/secure-storage-react-native": minor
---

An old copy of a secret is no longer left behind silently. After a rewrite (`set`, `setProtection`) the store swallowed a failed delete of the previous copy: `setProtection(id, 'biometricsOnly')` resolved, `info` / `list` reported strict mode while the `biometricsOrPasscode` copy stayed in the Keychain, a retry did nothing, and neither a restart nor `prune` removed it. Now `info` and `list` report the weakest protection among the copies still stored, the removal is retried on the next store operation, on first use after a restart and in `prune`, and `delete(id)` removes the oldest copy first, so a failure part-way never leaves an older copy as the one `get` reads. A `setProtection` call for the protection the newest copy already has removes any older copy without a sheet.

**Breaking:** `set` and `setProtection` reject with the new `SecureStorageError` code `stale-copy` when the new copy is stored but an older one could not be removed; `prune` rejects with it when an older copy of a kept secret stays. `SecureStorageErrorCode` gains `'stale-copy'`.

---
"@anywalletkit/extension-kit": patch
---

`Session` with `autoLockMs: 0` ("no auto-lock") stays unlocked in Chrome. The record stored `expiresAt: Infinity`; chrome.storage keeps JSON, Infinity became `null`, and the next read took the wallet for locked right after unlock. "No auto-lock" is now stored as `expiresAt: null`. A stored record that is there but unreadable (wrong types, a key that is not 32 bytes) now locks the wallet: it is removed and `onLock` listeners run.

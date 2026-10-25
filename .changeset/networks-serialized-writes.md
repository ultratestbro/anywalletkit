---
"@anywalletkit/networks": patch
---

`NetworksTable` writes made at once all land. Every write read the state, awaited, and saved a copy of what it had read, so with an asynchronous storage (AsyncStorage, `chrome.storage`) two writes at once (two `addRpc`, two `markRpc` after a verification round) lost one; `addRpc` / `removeRpc` read and wrote in two separate steps. Each write is now one serialized read → change → save, and memory changes only after the storage accepted the write. Audit 2026-10-25, #1.7.

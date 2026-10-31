---
"@anywalletkit/history-evm": patch
---

History paging no longer repeats rows after a backend switch. When a cursor written by one explorer was continued on a Blockscout list that had more than about ten pages of newer activity above the cursor, the next cursor moved up to newer blocks and the app got rows it had already shown. The block window now never moves above the cursor's bound: such pages come back empty with a cursor while the list catches up, then paging continues below the bound as before. Nothing to change in apps; keep following `next` until it is absent.

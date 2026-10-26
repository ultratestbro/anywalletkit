---
"@anywalletkit/kit": patch
---

`history()` pagination no longer skips or repeats rows. The merge sorted equal timestamps by chain and hash instead of each source's own order and counted a page as consumed up to the furthest row shown, so with same-second transactions a row was skipped for good or shown twice; a transaction landing at the head between two calls repeated a row; and a transfer between two own addresses on one chain showed twice when it sat on different pages of the two histories. The pages are now merged k-way, each in its source's order (only a prefix of a page is ever consumed), the cursor remembers the last row each page gave (`l`, older cursors still work), and a transaction sent from another own address the feed reads is shown from that address's history only.

---
"@anywalletkit/wallet-near": patch
---

History pages no longer duplicate a transaction whose receipt rows a page boundary cut: each list is read one row ahead, a transaction that goes on past the page waits for the next page whole, and one with more rows than a page goes out with the rows that fit while the next cursor skips the rest (new optional `skip` in the cursor; old cursors still decode).

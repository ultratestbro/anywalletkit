---
"@forgewallet/protocol-swap2-usdt0": patch
---

The sealed LayerZero fee carries 25 % headroom over the quote: the fee is paid at send time and moves with gas, so a quote a minute old failed preflight ("fee rose … re-quote"); the endpoint refunds the unused part to the trader in the same transaction. Preflight refuses only a fee past the headroom.

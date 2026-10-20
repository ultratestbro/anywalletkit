---
"@forgewallet/protocol-swap2-omniston": patch
---

EVM → TON disclosure: the EVM input validator no longer demands the source complement's amount to equal `resolverSendsUnits` for a TON destination — Omniston records a larger figure there (live: 1.089 ×), and strict equality blocked every EVM → TON secret disclosure; the delivered amount is proven on the TON position. EVM destinations keep the exact check. New `trace` option reports why a poll skipped disclosure (`disclosure-skipped`, `validator-refused`, `validator-threw`) and when it disclosed.

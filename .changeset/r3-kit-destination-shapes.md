---
"@anywalletkit/kit": patch
---

The policies read a transaction's destination from the field the chain package builds it from: Tron is prebuilt only with a `txID` and a contract call only with a `functionSelector` (otherwise a TRX send to `to`); Solana follows wallet-solana's order (wire, compiled `messageBytes` + `signatures`, `{ to, value }`, `instructions`); EVM is `to` only, so a transaction without `to` (a deployment) has an unknown destination. A shape that fits two readings is unknown, so an allowlisted field riding next to a drainer no longer passes the allowlist.

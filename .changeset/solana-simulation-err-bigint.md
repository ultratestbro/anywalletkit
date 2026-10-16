---
"@forgewallet/wallet-solana": patch
---

A structured simulation error is named instead of crashing the error formatter. `@solana/kit` parses every JSON integer in an RPC response as a bigint, so `{InstructionError: [2n, {Custom: 6001n}]}` made the plain `JSON.stringify` throw "Do not know how to serialize a BigInt" — and that message replaced the real on-chain failure (Solana USDe → SOL via LI.FI in the Oct 16 funded run). Both `simulateWire` and the serialized-transaction check now format the error with a bigint-safe replacer (SDK-134).

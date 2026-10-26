---
"@anywalletkit/wallet-solana": minor
---

`signCompiled` and `signTransactionMessage` now run the same checks as every other signing path: a drainer shape (an authority handed away, the wallet reassigned…), a burn or a durable nonce is refused unless the config or the new `options` argument (`SolanaWriteOptions`) opts in. They stay primitives: no simulation and no fee quote.

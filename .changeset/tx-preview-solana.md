---
"@anywalletkit/tx-preview-solana": minor
---

New package (beta): what a Solana transaction will do before it is signed. Every instruction is decoded through a pluggable decoder registry — System, SPL Token, Token-2022 (all 100 instructions of the official client, every extension), Associated Token, Compute Budget, Stake (both account layouts), Address Lookup Table, Memo, SPL Stake Pool (all 27 instructions; Jito and every pool on the program), Jupiter Aggregator v6 (every route variant, the full route plan) and Kamino Lend (all 66 instructions) — with unknown programs kept as raw accounts and data. Legacy, v0 and v1 messages; lookup tables resolved through the RPC. `describeTransaction(tx, { rpc, signer })` simulates and returns the signer's SOL and token balance changes and the decoded inner instructions; `decodeTransaction` works offline. Tested on 76 confirmed mainnet transactions, a round trip of every Token-2022 instruction and in the Hermes VM.

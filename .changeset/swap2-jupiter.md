---
"@forgewallet/protocol-swap2-jupiter": minor
"@forgewallet/wallet-solana": patch
"@forgewallet/conformance": minor
---

New provider `@forgewallet/protocol-swap2-jupiter`: same-chain Solana swaps through Jupiter's Swap API V2 Router path (`GET /swap/v2/build`, Metis routing, no Jupiter swap fee; keyless at 0.5 RPS or an `apiKey` sent as `x-api-key`). Nothing from the API is used unchecked: only Jupiter v6 and token / system / ATA / compute-budget instructions, the taker as the only signer, no tip, and the swap instruction's own arguments (`route_v2` / `shared_accounts_route_v2`) decoded — input amount, quoted output, slippage and a zero platform fee must equal the request. The v0 transaction is assembled locally with the response's lookup tables; the compute budget is ours (limit = 1.2× a simulation when `rpcUrls` is given, price capped by `maxComputeUnitPrice`). The account executes it through its serialized-transaction guard and its own RPC.

`wallet-solana`: the serialized-transaction guard counts the wallet's own wrapped-SOL token accounts as its SOL. Aggregator routes close the wallet's wSOL account, which also unwraps wSOL the wallet already held; that used to be refused as a token drain (live 2026-10-23: every large mainnet wallet probed held some wSOL), and a SOL output could not tell the wallet's own unwrapped wSOL from swap proceeds — now both are exact.

`conformance`: `createMockAccount({serialized: true})` exposes swap2's `sendSerializedTransaction` hook; the swap2 behaviour suite checks serialized legs (the fixture's `serialized` decoder must accept what would be signed, and the account must execute exactly the reviewed bytes with the engine's balance expectation).

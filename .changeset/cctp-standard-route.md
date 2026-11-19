---
"@anywalletkit/protocol-swap2-cctp": minor
---

Standard Transfer as its own route next to Fast. Quotes carry `routeId: "fast"` or `"standard"`, and `getQuotes` returns both where the pair has both, so a route list shows the free, slower burn (no Circle fee; waits for the source's hard finality) beside the fast one — only when it pays out more (no duplicate where Circle charges no Fast fee, Avalanche). A picked route is quoted or refused, never swapped: a `"fast"` request with Circle's Fast allowance used up is refused instead of becoming a Standard transfer, and a re-quote after an approval keeps the route. Without a `routeId`, `mode: "auto"` still takes Fast when offered, so existing callers see no change; `mode: "fast"` / `"standard"` keep one route only and refuse the other.

Standard's ETA now follows Circle's published attestation time per source domain (the upper end, plus the claim): 15–19 min from Ethereum, Arbitrum, Base, OP Mainnet, Unichain, World Chain, Plume and X Layer; ~30 min from Ink and Morph; 6–32 h from Linea; seconds from Avalanche, Polygon PoS, Sonic, Monad, Sei, HyperEVM, Plasma and Arc (was ~17–20 min everywhere). `STANDARD_ATTESTATION_SECONDS` exports the table.

Through a server, `remoteProvider({name: "cctp", baseUrl, multiQuotes: true, ...cctpPins})` lists both routes; `cctpVerifyQuote` refuses a quote whose `routeId` (or the requested one) is not its burn's finality threshold.

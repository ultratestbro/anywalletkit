---
"@anywalletkit/core": minor
"@anywalletkit/protocol-swap2-core": minor
"@anywalletkit/protocol-swap2-router": minor
---

Support multiple display routes per provider through optional `getQuotes`, stable
`routeId` selectors, and `using(provider, routeId)`. Validate and rank candidates
independently while preserving the selected provider, path and caller floor when
refreshing an expired quote after approval.

Add opt-in remote `/quotes` support (`multiQuotes: true`) with per-candidate validation,
client checks and sealed route identity. Existing single-quote providers and `awk1`
tracking IDs remain compatible.

---
"@anywalletkit/protocol-swap2-omniston": minor
---

An Omniston quote id reused by the platform can no longer replace the terms of a quote the app already holds (scan 2026-10-30 F6). The intent id now carries a digest of the quote's terms (assets, units, fees, resolver, settlement parameters, deadlines) on its dest segment (`<dest>#<digest>`, so apps already released still read the id). A held quote id is refreshed only by a quote with the same terms; a reused id with other terms is refused and the first quote kept, with or without the store's `claim`. `buildDeposit` and `registerSignedOrder` compare the cached quote with the intent's digest and refuse a mismatch with "quote was replaced — request a fresh quote". **Breaking:** an intent id issued by a previous version (no digest) is refused on build with "request a fresh quote"; tracking still reads it, so orders in flight across the update keep their disclosure.

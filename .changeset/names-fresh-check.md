---
"@anywalletkit/core": patch
"@anywalletkit/names-ens": patch
---

`assertNameUnchanged` — the signing-time check that a name still points where it pointed when it was typed — now asks for a fresh resolution (`resolve(name, chain, { fresh: true })`). It went through the resolver's cache (ENS: 5 minutes), so a name re-pointed in between passed. `NameResolver.resolve` takes the optional `{ fresh }` (a caching resolver must bypass its cache for it), `nameResolvers` passes it on, and the ENS resolver honours it (the fresh answer then refreshes the cache).

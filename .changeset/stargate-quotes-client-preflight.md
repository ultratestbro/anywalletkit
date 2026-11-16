---
"@anywalletkit/protocol-swap2-core": minor
"@anywalletkit/protocol-swap2-router": minor
"@anywalletkit/extension-kit": minor
---

Allow `etaSeconds: null` for routes without a defensible delivery estimate. Preserve
it through remote quote sealing, execution reviews and extension views. The router
does not award a speed bonus or fastest tag to an unknown ETA; `RouteSet.fastest`
is nullable and fastest preference falls back to best when every ETA is unknown.

Run the remote provider's client-side build validator again after backend preflight,
so approvals or review delays cannot bypass fresh client checks before signing.

---
"@anywalletkit/extension-kit": patch
---

`ApprovalQueue` limits beyond one origin, so a page that hops over subdomains cannot bury a real request under windows. New defaults: at most `APPROVALS_MAX_PENDING_PER_SITE` (5) requests waiting per site (registrable domain; subdomains share them) and `APPROVALS_MAX_PENDING_TOTAL` (20) in the whole queue, both -32005; and a per-site sheet rate (`openRate`: a token bucket, 10 at once and 10 a minute by default; running dry refuses with -32005 for a cooldown that starts at 30 s and doubles on each repeat, up to 10 min). Options `maxPendingPerSite`, `maxPendingTotal`, `openRate` (`false` turns the rate off), `siteOf` and `exempt` (origins that skip every limit — pass the wallet's own pages). New methods `declineOrigin(origin)` (the origin's last page closed) and `declineSite(site)` ("decline all from this site"), `siteFor(origin)` and `pendingForSite(site)`.

New helpers `siteOf(origin)` (a conservative registrable domain without a full Public Suffix List: the last two labels, three under `MULTI_LABEL_SUFFIXES` such as `co.uk`, `github.io`, `vercel.app`; a pseudo-origin such as `wc:<topic>` is its own site) and `TokenBucket` (a token bucket per key, memory only).

---
"@anywalletkit/names-ens": minor
---

CCIP-Read on React Native: its fetch follows a gateway's redirect whatever `redirect: 'error'` says, so a resolver's gateway could send the device's request to a LAN or loopback host before the final URL was checked. There, no resolver-chosen gateway is fetched with the global fetch any more. New `EnsCcipOptions` (`ensResolver({ ccip })`, `createEnsCcipRead(opts)`, `ensCcipRequest(params, opts)`): `fetch` is an app-supplied fetch that does not follow redirects (typically one that goes through your server's CCIP-Read proxy; the https / public-host check still runs first), and `allowRedirectFollowingFetch: true` restores direct lookups and accepts that a redirecting gateway can make the device send one blind request. A 3xx answer is never used. Browsers, extensions and Node, whose fetch honours `redirect: 'error'`, are unchanged.

**Breaking:** on React Native, offchain (CCIP-Read) names such as `cb.id`, Basenames and `uni.eth` subnames fail with `lookup-failed` unless `ccip.fetch` or `ccip.allowRedirectFollowingFetch` is set.

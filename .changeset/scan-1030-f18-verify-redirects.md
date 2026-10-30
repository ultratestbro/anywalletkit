---
"@anywalletkit/networks": minor
---

`verifyNetwork` refuses redirects (scan 2026-10-30, F18). The URL policy judged the address a user or a site gave, but the verifier then followed the endpoint's redirects, so a public https RPC from `wallet_addEthereumChain` could point the check at a plain-http or private address; and the target's answer came back in `error`.

- Requests go out with `redirect: 'error'`; an answer that shows a redirect anyway (a 3xx, `redirected: true`, `opaqueredirect`, or a `url` other than the one asked for) is `redirected: Endpoint redirected to <host>; enter the final URL`. `FetchLike` takes `redirect`, and `FetchResponseLike` may carry `url`, `redirected`, `type`, `headers`, `body` (all optional).
- `http-<status>` and `bad-json` errors carry the status only, never body text; an error body is not read.

**Breaking:** an endpoint that answers through a redirect no longer verifies — enter its final URL. A custom `fetch` that cannot refuse redirects should report `url` or `redirected`. Answer a site with a generic error rather than `result.error`. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

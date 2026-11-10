---
"@anywalletkit/extension-kit": minor
---

Signing sheet signals from the 2026-11-09 extension audit:

- `messageText` and the typed-data `text` now show every invisible or direction-changing character
  (Unicode Cf — bidi overrides / isolates, zero-width characters, BOM… — plus line separators and stray
  controls) as a visible `⟨U+XXXX⟩`; the request carries `hiddenChars: true` when anything was escaped. The
  bytes that get signed are unchanged. New export `revealHidden`.
- A Sign-In with Ethereum message containing bidi controls or zero-width characters is refused (-32602),
  like one with hidden control characters. New export `SIWE_FORBIDDEN_CHARS`.
- `describeSiwe` sets `crossSite: { domain, origin }` when the sign-in names another site than the one
  asking (new export `siweCrossSite`), so a sheet can make it the headline.
- `prepareTransaction` still signs a page's gas limit as given, but now also asks the wallet's RPC for an
  estimate and returns `gasCheck: { estimate, excessive }` — `excessive` when the page's limit is above
  max(estimate × 1.5, estimate + 50 000) (new export `gasLimitExcessive`). A failing estimate leaves
  `gasCheck` out and does not fail the request.

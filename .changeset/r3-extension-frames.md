---
"@anywalletkit/extension-kit": patch
---

New `pageRequestFrom(event, window)`: a content script's message listener takes a request only when the page window itself posted it (`event.source` is the page and `event.origin` its origin). Without it an iframe on the page (an ad, an embed) could `parent.postMessage` a request that was stamped with the site's origin and shown in the approval window as the site. The example extension's content script uses it.

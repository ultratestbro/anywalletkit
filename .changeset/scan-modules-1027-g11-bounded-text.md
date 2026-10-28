---
"@anywalletkit/extension-kit": minor
"@anywalletkit/protocol-swap2-core": minor
"@anywalletkit/protocol-swap2-balancer": minor
"@anywalletkit/protocol-swap2-fynd": minor
---

Text and calldata from a page, a client or an API are bounded before anything parses them. extension-kit: an error message is cut to its first line within 1 KB before its URLs are taken out (the URL regex has a bounded scheme), and a request's `method` must be a method name — letters, digits and `_`, at most 128 (`isRelayMethod`, `RELAY_METHOD_MAX`) — or the relay drops it and the router answers -32600 without echoing it. swap2-core: `redactUrls` is linear whatever the text (it also catches a URL right after `_` or glued to a long word now), and the server cuts a provider's refusal or error before redacting it. Balancer: `preflightDeposit` decodes and prices only the quote's own batch — a client's different `tx.data` is refused before it is decoded — with at most `BALANCER_MAX_SWAPS` (16) hops and no pool `userData`, and a longer SOR route is refused at the quote. Fynd: `preflightDeposit` simulates only the quote's own transaction (target, calldata, value), a refusal names the transaction target only when it is an address, and protocol names from the API are cut to 40 characters.

**Breaking:** extension-kit drops a relay request whose `method` is not a method name (answer it with -32600 in your injected provider); Balancer `preflightDeposit` refuses calldata that is not the quote's own batch, and Fynd's a transaction whose target, calldata or value differs from the quote's. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

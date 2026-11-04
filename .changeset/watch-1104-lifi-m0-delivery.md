---
"@anywalletkit/protocol-swap2-lifi": patch
---

An M0 order's destination token and amount are now checked against the quote: the order must ask the solver for the destination token and at least the minimum the user reviewed. An M0 order to a native destination token (ETH, POL, …) is always refused, as M0's facet itself refuses one. Before, only its recipient and refund addresses were checked. LI.FI's live M0 quotes already match. Nothing to change in apps.

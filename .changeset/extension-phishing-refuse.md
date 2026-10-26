---
"@anywalletkit/extension-kit": minor
---

A site on the shipped phishing list is now refused, not only warned about. `PhishingDetector.refusal(origin)` gives the reason for a listed host; `ApprovalQueueOptions.refuse` and `RouterDeps.refuse` take it and answer every request from that origin with EIP-1193 4100 (`OriginRefused` at the queue) before any approval window opens — reads, `eth_accounts` and an earlier permission included. Lookalikes and punycode still only warn. Wire both hooks; without them the behaviour is unchanged.

---
"@anywalletkit/protocol-swap2-omniston": patch
---

Remote TON → EVM orders work again. On 0.3.0, `omnistonVerifyBuild` could only open TON → TON swap bodies, so every TON → EVM order through `remoteProvider` was refused ("only TON swap bodies can be checked on the client") and apps turned the route off.

Now `createOmnistonTonValidators()` also returns `verifyTonEscrowBuild`, and `omnistonVerifyBuild({...createOmnistonTonValidators()})` sends TON → EVM escrow bodies to it. It runs the server's structural check (`validateTonEscrowPayload`'s layout).
- **From the app:** every field that decides where the trader's money goes — the jetton amount, the trader as owner and refund address, the destination chain, address and token, and a delivery of at least the quote's minimum.
- **Pinned:** the protocol contract, from `trustedProtocolAddresses`, by default the audited `AUDITED_OMNISTON_SETTLEMENT_CONTRACTS["ton:-239"]`.
- **Read from the body and held to the audited pins:** the fields the server and the resolver choose — quote id, resolver, hashlock, exclusivity, deposit. The audited pins are escrow and execution code, the authority key, one execution, the reviewed timelocks and no Dutch auction.

Checked on the live TON → EVM escrows captured on 2026-10-10 (USDT on TON → USDC on Base and on BNB), and in the Hermes VM.

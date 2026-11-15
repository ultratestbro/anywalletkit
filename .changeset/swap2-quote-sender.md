---
"@anywalletkit/protocol-swap2-core": minor
---

`QuoteParams.sender`: the account that signs the source transaction, set by the engine on every execution quote (its own address) and passed through by `createSwap2Handler`; absent on a dry quote. A provider whose deposit gives its sender more than refunds binds to it instead of `refundAddress`, which a caller may set to any address — an Across depositor can sign a speed-up that pays the output to another recipient.

---
"@anywalletkit/protocol-lending-kamino-solana": patch
---

A full withdrawal from an Earn vault works again. Kamino's API ends it with `CloseAccount` on the emptied shares account, rent back to the wallet, and the withdrawal's instruction rules allowed only the wSOL account's close, so the build was refused ("Instruction 5 (Tokenkeg…, data 09…) is not one this operation takes"). A withdrawal may now close the wallet's own shares account: the Token program on its derivation, Token-2022 on its own, the rent to the wallet and the wallet as the owner. Deposits still may not carry it, and closing any other account, or to another destination, is still refused.

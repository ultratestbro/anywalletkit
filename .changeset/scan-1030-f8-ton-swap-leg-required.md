---
"@anywalletkit/protocol-swap2-omniston": minor
---

Same-chain TON swaps prove the token the DEX pays out (scan 2026-10-30 F8). `validateTonSwapLeg` is now required, next to `validateTonJettonWallet` and `validateTonSwapTarget`, to advertise and build TON → TON swaps; before, a host without it got only a `ton-swap-payload legs-unverified` trace, and a genuine STON.fi or DeDust body that paid out another token at the quoted minimum was signed. `omnistonVerifyBuild` refuses a TON swap body without `validateTonSwapLeg`. `tonSwapPayloadCheck: "report"` still builds without it (and traces `legs-unverified`) as an explicit opt-in. `createOmnistonTonValidators()` supplies the hook; every live STON.fi v1/v2 and DeDust v1/CPMM v2 layout passes it.

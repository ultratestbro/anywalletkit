---
"@anywalletkit/protocol-swap2-core": minor
"@anywalletkit/protocol-swap2-router": patch
"@anywalletkit/protocol-swap2-omniston": minor
---

A TON cell-body deposit (`bodyBoc`) is bound to the swap on the client instead of being sent as the build said. The message may attach the input plus at most `tonGasCeiling` nanoTON of gas (new engine option, default 1 TON; live Omniston swaps attach 0.1–0.7) — a jetton source the ceiling alone. A jetton source's body must be a TEP-74 transfer of exactly the input, from this account's own jetton wallet (the account's `getJettonWalletAddress`; an account without it cannot execute such a swap), with the excess returning to this account. The decoded body reaches `reviewExecution` (`cellBodyDecoded`, next to `cellBody: true`). **A remote stub's cell body is refused unless the app gave it `verifyBuild`**, and a remote native-source body must go to a pinned `callTargets` address when the app pins any. Before, `{to: attacker, value: <whole balance>, bodyBoc}` or a transfer of the whole jetton balance to the attacker from the user's own jetton wallet went to the account untouched. `verifyBuild` now also receives the request the quote answered, and may be async; the router keeps a stub's `verifiesBuilds` flag. `tonRawAddress` (friendly/raw TON address comparison without @ton/core) is exported.

Omniston: `omnistonVerifyBuild({validateTonSwapTarget, validateTonSwapLeg, integratorAddress})` is the app's check of a remote TON swap build — `checkTonSwapPayload` against the app's own request plus the app's DEX validators; swap quotes carry `providerData.routeSteps` for it. A TON → EVM escrow body cannot be checked on the client and is refused by the helper.

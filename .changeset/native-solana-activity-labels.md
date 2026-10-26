---
"@anywalletkit/protocol-staking-native-solana": patch
---

Activity says when a stake account's SOL or control leaves the wallet. A Withdraw to another address read "Withdrew unstaked SOL" like a claim to the wallet; it is now "Withdrew unstaked SOL to Ab12…Cd34" with the address as counterparty and the subtitle saying it is not one of the wallet's addresses. An Authorize (`authorize`, `authorizeChecked`, …) is "Changed stake authority (staker / withdrawer)" with the new authority as counterparty, flagged when it is not the wallet's, instead of a neutral "Stake account update".

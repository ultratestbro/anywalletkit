---
"@forgewallet/keyring": minor
---

`missingChains(accountId)` lists the registered chains a seed account has no stored address for (a chain that joined after the account was created — addresses are computed once at creation), and `completeAddresses(sourceId)` derives and stores them for every account of the source with one secret read. An imported key never has missing chains.

---
"@forgewallet/kit": patch
---

`buildFeed` matches intent legs to chain rows through the chain alias table: an intent journaled under the catalog id (`bitcoin:mainnet`) now owns the row a source names by genesis hash (`bip122:…`), instead of leaving a bare "send" next to a pending intent; a row already on the page still inherits its intent.

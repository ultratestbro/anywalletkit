---
"@anywalletkit/keyring": patch
---

Two `addAccount` calls at once no longer hand out one index twice. The next index was picked before the serialized save, so both calls derived and returned account N, and the second one's name was never stored. The index, the derivation and the save now run in one serialized change (the secret is still read once, outside it), and every add returns the metadata as stored. Audit 2026-10-25, #1.2.

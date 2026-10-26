---
"@anywalletkit/protocol-lending-kamino-solana": patch
---

The vault's description from the Kamino API is checked before it shapes the wallet guard: it must be the configured vault on the kVault program, its shares mint must be the PDA the program derives (`["shares", vault]`), its asset must be the configured `asset` (new option), and its mint decimals must match the chain when the account can read mints. `supply` needs the asset named (`token` or `asset`), so a changed API answer can no longer make the wallet deposit another token or let a withdraw move any token out.

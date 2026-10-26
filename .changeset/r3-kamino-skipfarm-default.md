---
"@anywalletkit/protocol-lending-kamino-solana": minor
---

Kamino vault deposits keep the shares in the wallet by default (`skipFarm` now defaults to `true`), so the guard proves the shares arrive. Staked in the vault farm the shares never reach the wallet and the guard could only bound what leaves it: an API transaction that simply transferred the deposit elsewhere passed. Pass `skipFarm: false` to stake in the farm as the Kamino app does, knowing that leg relies on the API.

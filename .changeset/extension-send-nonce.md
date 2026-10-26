---
"@anywalletkit/extension-kit": minor
---

`eth_sendTransaction` takes the nonce after the review, not before. Two requests waiting at once used to show and sign the same nonce, so the second replaced the first or was refused. The nonce is now read after the approval under a per-account lock that also covers the broadcast, and never below the wallet's own next nonce. The fee caps signed are the ones shown; when the network outgrew them while the sheet was open (EIP-1559: base fee + tip above the shown cap; legacy: a higher gas price), the user is asked again with the new numbers (`SignApproval.repriced: true`).

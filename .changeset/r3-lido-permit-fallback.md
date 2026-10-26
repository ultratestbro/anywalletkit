---
"@anywalletkit/protocol-staking-lido-evm": patch
---

`requestWithdrawal` falls back to approve + request only when the permit does not work: an error from the permit transaction's broadcast (it may have been sent), a declined signature (`UserRejectedError`) and a policy refusal now end the call instead of sending an approval and a second request. Before an approval the module checks the token balance, the queue's pause and the 100 wei minimum, and a tail chunk under 100 wei is evened out with the chunk before it.

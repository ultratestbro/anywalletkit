---
"@anywalletkit/protocol-swap2-uniswap": minor
---

Unichain, Monad, Linea and X Layer now quote through Uniswap's active QuoterV2 (130 `0x385A5cf5F83e99f7BB2852b6A19C3538b9FA7658`, 143 `0x661E93cca42AfacB172121EF892830cA3b70F08d`, 59144 `0x42bE4D6527829FeFA1493e1fb9F3676d2425C3C1`, 196 `0xD1b797D92d87B688193A2B976eFc8D577D204343`) instead of the deprecated `Quoter`, which quoted the right amounts but always reported gas 0. The swap's gas limit was derived from that figure, so on these four chains it was 120,000 (160,000 with a native output) while a real swap uses about 170,000–275,000: the transaction passed simulation and then ran out of gas on chain. A quoter figure no real pool swap can cost now sets no gas limit at all, and the wallet estimates the exact call with headroom before broadcast. `UniswapDeployment.quoterWeth` is removed: every pinned quoter reports WETH9, and a `deployments` override whose quoter does not is refused like any other mismatched deployment.

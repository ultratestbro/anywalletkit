---
"@anywalletkit/tx-preview-evm": minor
"@anywalletkit/protocol-swap2-core": minor
---

`decodeCall` reads the approval and transfer calls the way the EVM executes them, not with a strict ABI decoder: selectors in any letter case, calldata that is too short zero-padded, address words by their low 20 bytes, any non-zero bool word as `true`. Before, `0x095EA7B3…` approves, a WETH9 approve one byte short and `setApprovalForAll(operator, 2)` threw in the decoder and showed as plain calls while the token contract executed them. Every Permit2 `approve(token, spender, uint160, uint48)` is an approval at any address (zkSync Era's Permit2 is not the CREATE2 one). Calldata that is not hex bytes is `undecodable: true` on the `DecodedCall` and a new `calldata-undecodable` warning in `checksFor`. swap2's quote and claim calldata gates refuse undecodable calldata.

**Breaking:** swap calldata that is not hex bytes is refused (it used to pass as a plain call). Approve and transfer calldata a strict ABI decoder rejected (an upper-case selector, a short last word, a non-canonical bool) is now read as the approval or transfer the token executes, and checked like one. A review can show the new warning code `calldata-undecodable`. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

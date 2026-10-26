---
"@anywalletkit/kit": minor
"@anywalletkit/wallet-solana": minor
---

The policies now see who a write really pays, not only the contract it calls. Recipients and spenders inside standard token calls are destinations: ERC-20 / 721 / 1155 transfers, approve, increaseAllowance, setApprovalForAll, Permit2 approve, an on-chain EIP-2612 permit, ERC-677 transferAndCall; TRC-20 calls (by `parameters` and inside `raw_data_hex`); NEAR `ft_transfer(_call)`, `nft_transfer(_call)`, `storage_deposit` for another account and `deleteAccount` (object and base64 borsh); TON jetton / NFT transfers and burns (destination and excess receiver, from a Cell or `bodyBoc`); SPL transfers, whose recipient is the token account's owner. An allowlist must hold the contract and the recipient. The intent of a single token transfer names its token and amount. wallet-solana gains `getTokenAccountOwner(address)`, which the policies use to read SPL recipients only when a list or `confirm` applies; an owner they cannot read makes the write `destinationUnknown`.

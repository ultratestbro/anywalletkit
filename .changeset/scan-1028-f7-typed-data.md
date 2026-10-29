---
"@anywalletkit/kit": minor
---

Policies read typed data that moves value by itself. EIP-3009 `TransferWithAuthorization` / `ReceiveWithAuthorization` is a `send` to `to` (token = the verifying contract, amount = `value`); an ERC-2771 `ForwardRequest` and a `MetaTransaction` are judged by the call they make, read like a transaction (the contract and whom standard token calldata pays); a 1inch LOP `Order` (the Omniston EVM order) by its settlement contract and a `receiver` other than the maker. Any other typed data stays `kind: 'typedData'` but now has `destinationUnknown: true` and `message: false`. A new `WriteIntent.verifyingContract` carries the domain's verifying contract, and a blocklist refuses it. Before, all of these were `message: true` with no destinations, so the allow/block lists never looked at them: a TransferWithAuthorization to an address the allowlist refused came back signed.

**Breaking:** under an allowlist, typed data the policies cannot read is refused, and so is any under a blocklist with no `confirm` hook (with `confirm`, the hook sees `destinationUnknown: true`). EIP-3009, ForwardRequest, MetaTransaction and LOP Order signatures need their destinations on the allowlist. Typed data whose verifying contract is blocklisted is refused, Permit / Permit2 included. `WriteIntent.message` is now `false` for every `signTypedData`.

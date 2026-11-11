---
"@anywalletkit/kit": minor
---

`applyPolicies`: an EVM `sign` of a string whose UTF-8 encoding — what an EIP-191 signer signs — is exactly 32 bytes
is no longer a plain message. Like a 32-byte `Uint8Array` or a `0x` + 64-hex string it is a blind hash signature (CoW
Protocol's `ethsign` orders and other verifiers of eth_sign-wrapped digests accept those 32 bytes as an order or a
transfer, and a site can grind an order until its digest is valid UTF-8): `kind: 'typedData'`, `message: false`,
`blindHash: true`, unknown destinations. New `WriteIntent.blindHashForm` (`'bytes' | 'hex' | 'text'`, type
`EvmSignBlindHashForm`) says which form came, so `confirm` can make it a danger screen and word it ("This looks like a
hidden hash. Signing it may authorize a transfer or an order.", Reject / Sign anyway); a `confirm` that already turns
`blindHash` into one covers it. The length is counted in UTF-8 bytes, not characters: 16 two-byte letters, 8 emoji
or a BOM plus 29 characters are 32 bytes; 32 characters with one `é` are 33. The guarded account is handed the
caller's string as it is, so for the `0x` + 64-hex form wallet-evm signs the 66 bytes of its text, as before.

- **Breaking:** for such text `kind` is `'typedData'`, no longer `'message'`. Without a `confirm` hook an allowlist now
  refuses it (`PolicyViolationError`, `allowlist`) and so does a blocklist (`blocklist`); with one, `confirm` gets
  it, under an allowlist too — the hex and bytes forms stay refused under an allowlist before `confirm`.
- **Breaking:** whether a `sign` is an EVM one follows the account's namespace, not the spelling of the chain it was
  asked for. An EVM account asked for by namespace (`getAccount('eip155')`), registered under another key
  (`registerWallet('evm', …)`), or wrapped with `applyPolicies(account, policies, 'eip155')` now gets all three
  forms flagged — the hex and bytes forms too, which passed there as plain messages. For those two forms that
  means: `confirm` gets `kind: 'typedData'` with `blindHash: true` instead of `kind: 'message'`; an allowlist
  refuses them, with or without `confirm` (`allowlist`); a blocklist refuses them when there is no `confirm`
  (`blocklist`).
- **Breaking:** the rules of the account's own namespace apply however it was asked for. An EVM account whose chain
  was not known yet (wallet-evm without `chainId`, offline or before its first `eth_chainId`) asked for under a key
  that is no chain id of its family — a registration key (`getAccount('evm')`, `getManager('evm')`),
  `applyPolicies(account, policies, 'ethereum')`, another family's id — matched no rule at all: a blind hash `sign`
  in every form and typed data without `domain.chainId` were signed with an `eip155` allowlist or blocklist in
  place. They are judged by the `eip155` rules now. Under such a key an exact-id rule (`'eip155:1'`) needs the
  account's chain as under a namespace (learned from the RPC, or `PolicyViolationError('chain')` offline), and the
  write is read on the account's chain: `confirm` gets `chain: 'eip155:…'` instead of the key, and a transaction's
  calldata is read as an EVM one (an ERC-20 recipient is a destination; under `'evm'` it was not seen).
- **Breaking:** a blind hash needs the account's chain like typed data when an exact-id rule of the family
  (`'eip155:1'`) could be the account's own: an account that reports `eip155:unknown` asks its RPC for the chain id
  first, and an offline one is refused with `PolicyViolationError('chain')`; before, it was signed without any rule.
- **Breaking:** an EVM `sign` of anything but a string or a `Uint8Array` (an array of numbers, another typed array
  even one whose species is `Uint8Array`, an `ArrayBuffer`, an array-like, `{ raw }`) is refused with
  `PolicyViolationError('method')` before any rule or `confirm` — wallet-evm read some of them as 32 raw bytes
  while the policies saw a plain message. A `Uint8Array` from another realm, a subclass or a Node `Buffer` still
  works.
- **Breaking:** an EVM `sign` of a string with a lone surrogate (a UTF-16 unit U+D800–U+DFFF that is not half of a
  pair) is refused with `PolicyViolationError('method')` before any rule or `confirm`. The `TextEncoder` polyfill of
  the Hermes setup (fastestsmallesttextencoderdecoder 1.0.22) encodes some of them differently from the spec — it
  swallows the unit after a lone high surrogate, and drops the last byte of a trailing one when exactly
  2 × length + 6 bytes come before it and its buffer has not grown — so 33 counted bytes could be signed as 32; on
  every well-formed string it, the spec and the kit agree.
- **Breaking:** the two refusals above (`method`) apply to every EVM account behind the policies, also with no rule
  configured: every account a `Wallet` created with `policies` hands out (`policies: {}` included), every account a
  protocol module is given, and an account of a `Wallet` without policies asked for by an exact chain id other than
  the one it reports (one that reports `eip155:unknown` too). An account of a `Wallet` without policies asked for by
  namespace, by a registration key or by the chain id it reports is the chain package's own, unchanged.
- **Breaking:** an EVM `sign` of a `Uint8Array` hands the account a plain `Uint8Array` of the kit's realm, copied
  from the argument's own elements: a Node `Buffer` arrives as a `Uint8Array`, a `Uint8Array` from another realm or
  a subclass as one of this realm. Before, the copy kept its class. An EVM account of your own that calls `Buffer`
  methods on the message must wrap it first (`Buffer.from(message)`); wallet-evm is not affected.

Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

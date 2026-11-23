---
"@anywalletkit/protocol-swap2-core": minor
"@anywalletkit/protocol-swap2-router": patch
---

Orders that rest before they settle (CoW Protocol), checked at the engine's own gate.

- **A GPv2 typed order is bound to the swap before anything is approved or signed** (`assertGpv2Order`): the GPv2Settlement domain on the source chain, the canonical `Order` type and nothing else, sell token, buy token, receiver, the exact input, a minimum at or above the quoted one, zero signed fee, a sell order with no partial fill and plain ERC-20 balances, an expiry within three hours, and the GPv2 vault relayer as the only spender. An account without `signTypedData` is refused before any approval is sent.
- **Permit instead of an approval**: a build may offer `permit` (EIP-2612 typed data) and `approvalAmount`. The engine signs the permit only for this account, the source token, the vault relayer, the exact amount and the order's own expiry (`assertGpv2Permit`), hands the signature to the provider's new `applyPermit`, and accepts the returned order only if nothing but `appData` changed. Both fields are refused on anything that is not a GPv2 order; `approvalAmount` must be a finite amount covering the input.
- **`cancelSwap2(id, account, { onchain? })`** with provider hooks `buildCancel`, `registerCancel`, `cancelTargets`: a typed cancellation is signed only for this account's own order UIDs (`assertGpv2Cancellation`); an on-chain cancel is plain calldata with no value to a contract the provider declared, never a transfer or an approval.
- `registerSignedOrder` may return `{ intentId }` — the id the placed order is tracked by.
- Router: the dispatch snapshot carries `applyPermit`, `buildCancel`, `registerCancel` and `cancelTargets`, so a routed order keeps its permit and cancel steps.

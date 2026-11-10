# @anywalletkit/protocol-swap2-relay

## 0.1.0

### Minor Changes

- 31cf3f0: New package: Relay (relay.link) as a swap2 provider that talks to Relay directly and verifies the whole order on the device before anything is signed. EVM to EVM, exact input, native coin and ERC-20 through the RelayDepository on 29 pinned chains. The order's EIP-712 hash is recomputed and held to the id in the deposit calldata, the solver's signature must recover to the pinned signer, and recipient, chains, tokens, amounts, minimum, deadlines and every refund recipient are held to the request; the deposit and the exact approval are built locally for the pinned depository. Every refusal has a named reason.

### Patch Changes

- Updated dependencies [6d6e801]
- Updated dependencies [ff6582a]
  - @anywalletkit/swap2-assets@0.3.0
  - @anywalletkit/protocol-swap2-core@0.10.3

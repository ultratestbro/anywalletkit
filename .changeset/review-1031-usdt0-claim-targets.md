---
"@anywalletkit/protocol-swap2-usdt0": minor
---

USDT0 stored-payload claims now work through `claimSwap2`. When LayerZero stores a delivery that reverted on the destination (`PAYLOAD_STORED`), the provider reports the swap as action-required and builds the `lzReceive` retry on the destination's LayerZero endpoint, but it declared no claim contracts, so `claimSwap2` refused every such claim. The new `usdt0ClaimTargets(chain)` names the destination chain's EndpointV2, and both the provider and `usdt0Pins` carry it. Apps that use a remote USDT0 provider get it by spreading `usdt0Pins` into `remoteProvider({...})` as before; a claim the server points at any other contract is still refused.

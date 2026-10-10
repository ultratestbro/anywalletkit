import {describeProtocolModule} from "@forgewallet/conformance";
import {LifiSwap2Protocol} from "../src/protocol.js";

// Shared swap2 conformance: full surface, read-only account refuses writes, reads never broadcast.
describeProtocolModule("protocol-swap2-lifi", {
  type: "swap2",
  Protocol: LifiSwap2Protocol,
  config: {fromChain: "eip155:1", skipAccountChainCheck: true},
  samples: {getSupportedChains: []},
});

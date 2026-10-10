import {describeProtocolModule} from "@forgewallet/conformance";
import {NearIntentsSwap2Protocol} from "../src/protocol.js";

// Shared swap2 conformance: full surface, read-only account refuses writes, reads never broadcast.
describeProtocolModule("protocol-swap2-near-intents", {
  type: "swap2",
  Protocol: NearIntentsSwap2Protocol,
  config: {fromChain: "eip155:1", skipAccountChainCheck: true},
  samples: {getSupportedChains: []},
});

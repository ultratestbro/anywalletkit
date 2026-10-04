import {describeProtocolModule} from "@forgewallet/conformance";
import {NearIntentsSwidgeProtocol} from "../src/protocol.js";

// Shared swidge conformance: full surface, read-only account refuses writes, reads never broadcast.
describeProtocolModule("protocol-swidge-near-intents", {
  type: "swidge",
  Protocol: NearIntentsSwidgeProtocol,
  config: {fromChain: "eip155:1", skipAccountChainCheck: true},
  samples: {getSupportedChains: []},
});

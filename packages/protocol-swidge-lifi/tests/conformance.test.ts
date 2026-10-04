import {describeProtocolModule} from "@forgewallet/conformance";
import {LifiSwidgeProtocol} from "../src/protocol.js";

// Shared swidge conformance: full surface, read-only account refuses writes, reads never broadcast.
describeProtocolModule("protocol-swidge-lifi", {
  type: "swidge",
  Protocol: LifiSwidgeProtocol,
  config: {fromChain: "eip155:1", skipAccountChainCheck: true},
  samples: {getSupportedChains: []},
});

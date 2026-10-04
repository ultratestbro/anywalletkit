import "../src/buffer-global.js";
import {describeProtocolModule} from "@forgewallet/conformance";
import {OmnistonSwidgeProtocol} from "../src/protocol.js";

// Shared swidge conformance: full surface, read-only account refuses writes, reads never broadcast.
describeProtocolModule("protocol-swidge-omniston", {
  type: "swidge",
  Protocol: OmnistonSwidgeProtocol,
  config: {fromChain: "eip155:1", skipAccountChainCheck: true},
  samples: {getSupportedChains: []},
});

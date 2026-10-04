import {describeProtocolModule} from "@forgewallet/conformance";
import {ThorchainSwidgeProtocol} from "../src/protocol.js";

// Shared swidge conformance: full surface, read-only account refuses writes, reads never broadcast.
describeProtocolModule("protocol-swidge-thorchain", {
  type: "swidge",
  Protocol: ThorchainSwidgeProtocol,
  config: {fromChain: "eip155:1", skipAccountChainCheck: true},
  samples: {getSupportedChains: []},
});

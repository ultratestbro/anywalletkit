import {describeProtocolModule} from "@forgewallet/conformance";
import {RouterSwidgeProtocol} from "../src/swidge/router.js";

describeProtocolModule("protocol-swidge-router", {
  type: "swidge",
  Protocol: RouterSwidgeProtocol,
  config: {fromChain: "eip155:1", skipAccountChainCheck: true, providers: []},
  samples: {getSupportedChains: []},
});

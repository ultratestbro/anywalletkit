import {describeProtocolModule} from "@forgewallet/conformance";
import {CrossChainRouter} from "@forgewallet/protocol-swidge-core/router";
import {RouterSwidgeProtocol} from "../src/swidge/router.js";

describeProtocolModule("protocol-swidge-router", {
  type: "swidge",
  Protocol: RouterSwidgeProtocol,
  config: {fromChain: "eip155:1", skipAccountChainCheck: true, router: new CrossChainRouter([])},
  samples: {getSupportedChains: []},
});

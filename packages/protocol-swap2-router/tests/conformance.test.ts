import {describeProtocolModule} from "@forgewallet/conformance";
import {RouterSwap2Protocol} from "../src/swap2/router.js";

describeProtocolModule("protocol-swap2-router", {
  type: "swap2",
  Protocol: RouterSwap2Protocol,
  config: {fromChain: "eip155:1", skipAccountChainCheck: true, providers: []},
  samples: {getSupportedChains: []},
});

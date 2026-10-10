import {describeProtocolModule} from "@forgewallet/conformance";
import {CctpSwap2Protocol} from "../src/protocol.js";

describeProtocolModule("protocol-swap2-cctp", {
  type: "swap2",
  Protocol: CctpSwap2Protocol,
  config: {fromChain: "eip155:8453", skipAccountChainCheck: true},
  samples: {getSupportedChains: []},
});

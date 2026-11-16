import {describeProtocolBehaviour, describeProtocolModule} from "@anywalletkit/conformance";
import {StargateSwap2Protocol} from "../src/protocol.js";
import {actor, setup} from "./helpers/rpc.js";

const f = setup();
describeProtocolModule("protocol-swap2-stargate", {
  type: "swap2", Protocol: StargateSwap2Protocol,
  config: {...f.config, fromChain: f.source.chain, enabled: true, skipAccountChainCheck: true},
  samples: {getSupportedChains: []}, mustResolve: ["getSupportedChains"],
});

for (const native of [false, true]) {
  const f = setup(native ? "eip155:8453" : "eip155:56", "eip155:42161", native ? 13 : 1);
  describeProtocolBehaviour(`protocol-swap2-stargate ${native ? "native" : "ERC20"}`, {
    type: "swap2", Protocol: StargateSwap2Protocol,
    config: {...f.config, fromChain: f.source.chain, enabled: true, skipAccountChainCheck: true},
    fixtures: ["taxi"].map((routeId) => ({
      name: `${routeId}: exact approval, review, pinned sendToken and messaging value`,
      options: {routeId, fromToken: f.source.symbol, toToken: f.destination.token, toChain: f.destination.chainId, recipient: actor, fromTokenAmount: f.request.amount, minAmountOut: 1n},
      fetch: f.config.fetchImpl, account: {address: actor}, own: [actor],
      ...(!native ? {sourceToken: f.source.token, spender: f.source.address} : {}),
    })),
  });
}

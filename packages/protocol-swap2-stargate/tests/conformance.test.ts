import {decodeFunctionData, type Hex} from "viem";
import {describeProtocolBehaviour, describeProtocolModule} from "@anywalletkit/conformance";
import {STARGATE_ABI} from "../src/abi.js";
import {StargateSwap2Protocol} from "../src/protocol.js";
import {actor, setup} from "./helpers/rpc.js";

const f = setup();
describeProtocolModule("protocol-swap2-stargate", {
  type: "swap2", Protocol: StargateSwap2Protocol,
  config: {...f.config, fromChain: f.source.chain, enabled: true, skipAccountChainCheck: true},
  samples: {getSupportedChains: []}, mustResolve: ["getSupportedChains"],
});

// sendToken pays SendParam.to (an EVM address in the low 20 bytes) and refunds unused messaging fee to its third argument.
const stargatePays = (source: {kind: string; data?: string}): string[] => {
  const {functionName, args} = decodeFunctionData({abi: STARGATE_ABI, data: source.data as Hex});
  if (functionName !== "sendToken") throw new Error("not a Stargate sendToken call");
  const [sp, , refund] = args;
  if (sp.to.slice(2, 26) !== "0".repeat(24) || sp.composeMsg !== "0x") throw new Error("not a plain EVM recipient");
  return [`0x${sp.to.slice(26)}`, refund];
};

for (const native of [false, true]) {
  const f = setup(native ? "eip155:8453" : "eip155:56", "eip155:42161", native ? 13 : 1);
  describeProtocolBehaviour(`protocol-swap2-stargate ${native ? "native" : "ERC20"}`, {
    type: "swap2", Protocol: StargateSwap2Protocol,
    config: {...f.config, fromChain: f.source.chain, enabled: true, skipAccountChainCheck: true},
    fixtures: ["taxi"].map((routeId) => ({
      name: `${routeId}: exact approval, review, pinned sendToken and messaging value`,
      options: {routeId, fromToken: f.source.symbol, toToken: f.destination.token, toChain: f.destination.chainId, recipient: actor, fromTokenAmount: f.request.amount, minAmountOut: 1n},
      fetch: f.config.fetchImpl, account: {address: actor}, own: [actor], decode: stargatePays, callTargets: [f.source.address],
      ...(!native ? {sourceToken: f.source.token, spender: f.source.address} : {}),
    })),
  });
}

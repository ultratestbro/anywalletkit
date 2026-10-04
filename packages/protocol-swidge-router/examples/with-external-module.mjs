// The router does not compete with other people's modules — it auctions them.
// Any `SwidgeProtocol` module joins through `modules[]`, any `BridgeProtocol`
// through `bridgeModuleAdapter`, and both are held to the same validation, fee
// caps and execution floor as the built-in venues.
//
//   npm i <a venue's own swidge module>
//   RECIPIENT=<0x…> RPC_URL=<your Ethereum RPC> node examples/with-external-module.mjs
//
// RECIPIENT must be a real, well-formed address on the DESTINATION chain: the
// venue validates it, and a placeholder comes back as "no route available"
// rather than as a validation error.

import RouterSwidgeProtocol, {
  CrossChainRouter,
  nearIntentsProvider,
} from "@forgewallet/protocol-swidge-router";
import LifiSwidgeProtocol from "@vendor/swidge-module";

const recipient = process.env.RECIPIENT;
const provider = process.env.RPC_URL;
if (!recipient || !provider) throw new Error("set RECIPIENT and RPC_URL");

const protocol = new RouterSwidgeProtocol(undefined, {
  fromChain: "eip155:1",
  router: new CrossChainRouter([nearIntentsProvider({enabled: true})]),
  modules: [
    {
      name: "lifi",
      protocol: new LifiSwidgeProtocol(undefined, {provider}),
      // `mapOptions` translates our CAIP-2 options into the module's own
      // notation. The default handles `eip155:N` -> numeric chain id, which is
      // what LI.FI expects, so it can be omitted here.
    },
  ],
});

const quote = await protocol.quoteSwidge({
  fromToken: "USDT",
  toToken: "USDC",
  toChain: "eip155:42161",
  fromTokenAmount: 100_000_000n, // 100 USDT
  recipient,
});

console.log("out (quoted) ", quote.toTokenAmount);
console.log("out (minimum)", quote.toTokenAmountMin);

// Whichever side won, status resolves back to it: the id carries the venue, so
// `getSwidgeStatus(result.id)` reaches the external module's own tracker when
// the external module was the winner.

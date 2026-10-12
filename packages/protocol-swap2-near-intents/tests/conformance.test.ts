import {describeProtocolBehaviour, describeProtocolModule} from "@forgewallet/conformance";
import {NearIntentsSwap2Protocol} from "../src/protocol.js";

// Shared swap2 conformance: full surface, read-only account refuses writes, reads never broadcast.
describeProtocolModule("protocol-swap2-near-intents", {
  type: "swap2",
  Protocol: NearIntentsSwap2Protocol,
  config: {fromChain: "eip155:1", skipAccountChainCheck: true},
  samples: {getSupportedChains: []},
});

// Behavioural conformance: a 1Click deposit-address quote (same shape as provider.test.ts).
const SENDER = "0x4444444444444444444444444444444444444444";
const DEPOSIT = "0x5555555555555555555555555555555555555555";
const TON_USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const oneClick = (amountIn: string) => (async (url: string) => new Response(JSON.stringify(String(url).endsWith("/quote")
  ? {quote: {depositAddress: DEPOSIT, amountIn, amountOut: "990000", minAmountOut: "980000", deadline: new Date(Date.now() + 60_000).toISOString()}}
  : {}))) as unknown as typeof fetch;
const toTon = {toToken: TON_USDT, toChain: "ton:-239", recipient: "UQdest", minAmountOut: 980_000n};
describeProtocolBehaviour("protocol-swap2-near-intents", {
  type: "swap2",
  Protocol: NearIntentsSwap2Protocol,
  config: {fromChain: "eip155:1", apiUrl: "https://near.invalid"},
  fixtures: [
    {
      name: "USDT Ethereum → TON (ERC-20 transfer to the deposit address)",
      options: {...toTon, fromToken: "USDT", fromTokenAmount: 1_000_000n},
      fetch: oneClick("1000000"), account: {address: SENDER}, own: ["UQdest"], depositAddress: DEPOSIT,
      sourceToken: "0xdAC17F958D2ee523A2206206994597C13D831ec7",
    },
    {
      name: "ETH Ethereum → TON (native send to the deposit address)",
      options: {...toTon, fromToken: "ETH", fromTokenAmount: 1_000_000_000_000_000n},
      fetch: oneClick("1000000000000000"), account: {address: SENDER}, own: ["UQdest"], depositAddress: DEPOSIT,
    },
  ],
});

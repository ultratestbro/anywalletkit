// A quote binds nothing and moves nothing, so it needs no account: this asks
// 1Click what 0.01 ETH on Ethereum is worth as TON on TON.
//
//   RECIPIENT=<your TON address> node examples/quote-eth-to-ton.mjs
//
// Optional: NEAR_INTENTS_JWT for the rate tier tied to your 1Click key.
//
// RECIPIENT must be a real, well-formed address on the DESTINATION chain: the
// venue validates it, and a placeholder comes back as "no route available"
// rather than as a validation error.

import NearIntentsSwap2Protocol from "@anywalletkit/protocol-swap2-near-intents";

const recipient = process.env.RECIPIENT;
if (!recipient) throw new Error("set RECIPIENT to the destination-chain address");

const protocol = new NearIntentsSwap2Protocol(undefined, {
  fromChain: "eip155:1",
  enabled: true,
  ...(process.env.NEAR_INTENTS_JWT ? {jwt: process.env.NEAR_INTENTS_JWT} : {}),
});

const quote = await protocol.quoteSwap2({
  // Source tokens are catalog symbols; destination tokens are the chain's own
  // identifier. TON's native coin has no contract, so the empty string selects
  // it — a symbol like "TON" would not resolve and the route would come back
  // empty.
  fromToken: "ETH",
  toToken: "",
  toChain: "ton:-239",
  fromTokenAmount: 10_000_000_000_000_000n, // 0.01 ETH, base units
  recipient,
});

console.log("in           ", quote.fromTokenAmount, "wei");
console.log("out (quoted) ", quote.toTokenAmount, "nanoton");
// This is the number that matters: swap2() executes against this floor, and a
// re-quote below it is refused rather than silently filled.
console.log("out (minimum)", quote.toTokenAmountMin, "nanoton");
if (quote.estimatedDuration) console.log("eta          ", quote.estimatedDuration, "s");
for (const fee of quote.fees) {
  console.log(`fee ${fee.type.padEnd(8)} ${fee.amount} ${fee.token}${fee.included ? " (in the rate)" : ""}`);
}

// THORChain settles natively — ETH on Ethereum leaves as real BTC on Bitcoin,
// no wrapped asset in the middle. Quoting needs no account and no key.
//
//   RECIPIENT=<your BTC address> node examples/quote-eth-to-btc.mjs
//
// Optional: THORCHAIN_AFFILIATE + THORCHAIN_AFFILIATE_BPS — both or neither;
// configuring one without the other is refused rather than silently ignored.
//
// RECIPIENT must be a real, well-formed address on the DESTINATION chain: the
// venue validates it, and a placeholder comes back as "no route available"
// rather than as a validation error.

import ThorchainSwap2Protocol from "@anywalletkit/protocol-swap2-thorchain";

const recipient = process.env.RECIPIENT;
if (!recipient) throw new Error("set RECIPIENT to a Bitcoin address");

const affiliate = process.env.THORCHAIN_AFFILIATE;
const affiliateBps = process.env.THORCHAIN_AFFILIATE_BPS;

const protocol = new ThorchainSwap2Protocol(undefined, {
  fromChain: "eip155:1",
  enabled: true,
  ...(affiliate && affiliateBps ? {affiliate, affiliateBps} : {}),
});

const quote = await protocol.quoteSwap2({
  fromToken: "ETH",
  toToken: "BTC",
  toChain: "bitcoin:mainnet",
  fromTokenAmount: 50_000_000_000_000_000n, // 0.05 ETH, base units
  recipient,
});

console.log("in           ", quote.fromTokenAmount, "wei");
console.log("out (quoted) ", quote.toTokenAmount, "sats");
console.log("out (minimum)", quote.toTokenAmountMin, "sats");
if (quote.estimatedDuration) console.log("eta          ", quote.estimatedDuration, "s");

// The floor above is what execution is bound to. The module rebuilds the swap
// memo canonically from these local facts rather than trusting the gateway, and
// re-checks THORChain's rotating inbound vault immediately before broadcast.

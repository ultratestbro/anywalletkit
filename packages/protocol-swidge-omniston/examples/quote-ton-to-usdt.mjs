// Omniston is an RFQ venue: resolvers compete over a WebSocket and settlement
// runs through an HTLC. Quoting is still read-only — no account, no key.
//
//   RECIPIENT=<0x…> node examples/quote-ton-to-usdt.mjs
//
// Note the two safety-relevant knobs below. `trustedSettlementContracts` is a
// per-chain allowlist: the venue is inert without it, because executing a
// resolver's payload against an unvetted settlement contract is exactly the
// attack this module refuses to enable. And the default in-memory stores are
// fine for a script but NOT for serverless — an HTLC secret that does not
// survive the process is a stranded swap.
//
// RECIPIENT must be a real, well-formed address on the DESTINATION chain: the
// venue validates it, and a placeholder comes back as "no route available"
// rather than as a validation error.

import OmnistonSwidgeProtocol from "@forgewallet/protocol-swidge-omniston";

const recipient = process.env.RECIPIENT;
if (!recipient) throw new Error("set RECIPIENT to an EVM address");

const protocol = new OmnistonSwidgeProtocol(undefined, {
  fromChain: "ton:-239",
  enabled: true,
  maxUsd: "1000",
  // Addresses you have audited yourself, keyed by CAIP-2 chain.
  trustedSettlementContracts: {
    "ton:-239": (process.env.OMNISTON_TON_SETTLEMENT ?? "").split(",").filter(Boolean),
    "eip155:1": (process.env.OMNISTON_EVM_SETTLEMENT ?? "").split(",").filter(Boolean),
  },
});

const quote = await protocol.quoteSwidge({
  fromToken: "USDT",
  toToken: "USDT",
  toChain: "eip155:1",
  fromTokenAmount: 20_000_000n, // 20 USDT on TON, 6 decimals
  recipient,
});

console.log("out (quoted) ", quote.toTokenAmount);
console.log("out (minimum)", quote.toTokenAmountMin);
if (quote.expiry) console.log("expires at   ", new Date(quote.expiry * 1000).toISOString());

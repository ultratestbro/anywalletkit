---
"@anywalletkit/protocol-swap2-near-intents": patch
---

When 1Click refuses a quote for its amount floor, the refusal passed to `onRefusal` (and so the router's rejection and the swap2 server's `{noQuote}`) is now a stable, presentable reason instead of the raw 1Click text with a debug suffix: "Temporary swap limits: minimum swap amount is $1,000" (BNB Chain under $1,000, Tron sources under $100) becomes `near_intents: below the 1Click minimum ($1,000)`, and "Amount is too low for bridge, try at least 150000" becomes `near_intents: below the 1Click minimum (at least 0.15 USDC)`, in the source token. Every other refusal is unchanged, and the server log line still carries the full 1Click answer and the request details.

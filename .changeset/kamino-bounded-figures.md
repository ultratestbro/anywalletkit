---
"@anywalletkit/protocol-lending-kamino-solana": patch
---

Figures from Kamino's API are bounded before they are parsed. `fromDecimalString` refuses an exponent beyond ±400, an input or a base-unit result over 1 000 digits, and both it and `toDecimalString` refuse decimals that are not an integer from 0 to 255. Before, a few bytes such as `"tokensPerShare": "1e300000000"` from a compromised or custom API endpoint built strings and a BigInt of hundreds of millions of digits on the JS thread, freezing or killing the app when a vault screen loaded. No real figure comes near these bounds.

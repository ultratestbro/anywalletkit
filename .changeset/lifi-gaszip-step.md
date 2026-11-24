---
"@anywalletkit/protocol-swap2-lifi": patch
---

Refuse a route whose source swaps carry a LI.FI gas step (GasZipPeriphery `depositToGasZip*`, "LI.Fuel"): it sells part of the input for native gas paid to a receiver written only in that step's own callData, which the Diamond check did not read — a changed gas receiver passed every other check (recorded live 2026-11-24). This module never asks for gas (`fromAmountForGas`), so any such step is refused as `recipient_unverifiable`.

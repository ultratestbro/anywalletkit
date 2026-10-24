---
"@anywalletkit/wallet-tron": minor
---

`signRaw` and every prebuilt-transaction path now verify the bytes before anything is shown or signed: `raw_data_hex` is required, `txID` must equal `sha256(raw_data_hex)` (`txid-mismatch`), the JSON `raw_data` must agree with the bytes field by field (`raw-mismatch`), and the hard checks run on the decoded bytes. `describeTransaction` describes the bytes, not the JSON (`no-raw-hex` / `raw-undecodable` / `undecoded` / `account-permission` / `multi-contract` warnings). New: `decodeRawData`, `encodeRawData`, `verifyRawTransaction`, `rawMismatch`, `readFields`, `CONTRACT_TYPES`; `trc10-transfer` kind. Closes the blind-signing hole where a dApp could show one transaction and have another signed (SDK-142 C1).

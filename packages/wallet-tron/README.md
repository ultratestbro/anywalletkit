# @forgewallet/wallet-tron

Tron accounts at `m/44'/195'/0'/0/i` (BIP-44 — TronLink default),
pinned by golden vectors in `@forgewallet/conformance`. No tronweb: the full-node
HTTP API builds `raw_data`, the account signs `txID` with noble secp256k1.

```ts
import WalletManagerTron from '@forgewallet/wallet-tron'

const wallet = new WalletManagerTron(seedPhrase, { provider: ['https://api.trongrid.io', 'https://tron-rpc.example'] , headers: { 'TRON-PRO-API-KEY': key } })
const account = await wallet.getAccount(0)
await account.transfer({ recipient: 'T…', amount: 1_000_000n })                    // 1 TRX (sun)
await account.transfer({ token: USDT_TRC20, recipient: 'T…', amount: 1_000_000n }) // TRC-20
await account.sendTransaction({ contractAddress, functionSelector: 'approve(address,uint256)', parameters: [...] })
const sig = await account.sign('hello')                                            // TIP-191, 0x + r||s||v (27/28)
wallet.dispose()
```

Fees are quoted from chain resources: bandwidth (after free/frozen allowance), energy
(after available energy, at `getEnergyFee`) and the 1 TRX activation fee when
the recipient account does not exist yet.

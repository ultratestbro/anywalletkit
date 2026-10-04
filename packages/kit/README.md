# @forgewallet/kit

The orchestrator. Chain packages and protocol modules are registered; the kit
hands out accounts by CAIP-2 chain id and protocols by name, all fed by one
seed phrase or one external `Signer`, all wrapped by the same policies.

```ts
import { Wallet } from '@forgewallet/kit'
import WalletManagerEvm from '@forgewallet/wallet-evm'
import WalletManagerSolana from '@forgewallet/wallet-solana'

const wallet = new Wallet(seedPhrase, {
  policies: {
    maxFee: { 'eip155:1': 10n ** 16n },                 // 0.01 ETH
    allowlist: { 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': [TREASURY] },
    confirm: async (intent) => ui.confirm(intent),      // last word before broadcast
  },
})
wallet.registerWallet('eip155', WalletManagerEvm, { provider: ['https://rpc-a', 'https://rpc-b'] })
wallet.registerWallet('solana', WalletManagerSolana, { provider: SOL_RPC })
wallet.registerProtocol('lido', LidoProtocolEvm, { chain: 'eip155:1' })

const eth = await wallet.getAccount('eip155:1')          // policies applied
await eth.transfer({ recipient: '0x…', amount: 10n ** 15n })
const lido = await wallet.getProtocol<LidoProtocolEvm>('lido')
wallet.dispose()                                          // zeroizes every chain's keys
```

Policies run before anything is broadcast, in this order: fee cap (quotes first),
allowlist, blocklist, `confirm`. Reads and offline signing are never intercepted.

// #region kit
import { Wallet } from '@anywalletkit/kit'
import { WalletManagerEvm } from '@anywalletkit/wallet-evm'
import { RouterSwap2Protocol } from '@anywalletkit/protocol-swap2-router'
import { providers } from './swap.ts'

export function walletWithSwaps(seedPhrase: string): Wallet {
  const wallet = new Wallet(seedPhrase, {
    // Policies wrap the account the router signs with: swaps cannot skip them.
    policies: { maxFee: { 'eip155:1': 5_000_000_000_000_000n } },
  })
  wallet.registerWallet('eip155:1', WalletManagerEvm, { provider: 'https://ethereum-rpc.publicnode.com', chainId: 1 })
  wallet.registerProtocol('swap', RouterSwap2Protocol, {
    chain: 'eip155:1',
    config: { fromChain: 'eip155:1', providers: providers() },
  })
  return wallet
}

// const swaps = await wallet.getProtocol<RouterSwap2Protocol>('swap')
// #endregion kit

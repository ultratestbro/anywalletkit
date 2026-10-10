// Morpho deployments per chain. The Morpho (Blue) addresses are from
// docs.morpho.org (Ethereum, Base, Arbitrum, OP, Polygon, Katana, HyperEVM) and
// confirmed against the markets the Morpho API lists; the vault factories are
// the factories behind every *listed* vault in the Morpho API on 2026-10-10
// (the docs page carries no factory table). A vault that no known factory
// acknowledges is refused unless the caller opts in — the factory check is the
// only on-chain proof that an address is a Morpho vault and not a look-alike.
import type { Address } from 'viem'

export interface MorphoChain {
  chainId: number
  name: string
  /** Morpho (Blue) singleton. */
  morpho: Address
  /** MetaMorpho / Vault V1 factories (v1.0 and v1.1 where both exist). */
  vaultV1Factories: Address[]
  /** Vault V2 factory. */
  vaultV2Factories: Address[]
}

const chain = (chainId: number, name: string, morpho: Address, vaultV1Factories: Address[], vaultV2Factories: Address[]): MorphoChain =>
  ({ chainId, name, morpho, vaultV1Factories, vaultV2Factories })

export const MORPHO_CHAINS: Readonly<Record<number, MorphoChain>> = Object.freeze({
  1: chain(1, 'Ethereum', '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
    ['0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101', '0x1897A8997241C1cD4bD0698647e4EB7213535c24'], ['0xA1D94F746dEfa1928926b84fB2596c06926C0405']),
  8453: chain(8453, 'Base', '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
    ['0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101', '0xFf62A7c278C62eD665133147129245053Bbf5918'], ['0x4501125508079A99ebBebCE205DeC9593C2b5857']),
  42161: chain(42161, 'Arbitrum', '0x6c247b1F6182318877311737BaC0844bAa518F5e',
    ['0x878988f5f561081deEa117717052164ea1Ef0c82'], ['0x6b46fa3cc9EBF8aB230aBAc664E37F2966Bf7971']),
  10: chain(10, 'OP Mainnet', '0xce95AfbB8EA029495c66020883F87aaE8864AF92',
    ['0x3Bb6A6A0Bc85b367EFE0A5bAc81c5E52C892839a'], ['0x6128b680b277Bf4Df80DFE9D8c55A498660870ef']),
  137: chain(137, 'Polygon', '0x1bF0c2541F820E775182832f06c0B7Fc27A25f67',
    ['0xa9c87daB340631C34BB738625C70499e29ddDC98'], ['0xC11a53eE9B1eCc7a068D8e40F8F17926584F97Cf']),
  130: chain(130, 'Unichain', '0x8f5ae9CddB9f68de460C77730b018Ae7E04a140A',
    ['0xe9EdE3929F43a7062a007C3e8652e4ACa610Bdc0'], []),
  999: chain(999, 'HyperEVM', '0x68e37dE8d93d3496ae143F2E900490f6280C57cD',
    ['0xec051b19d654C48c357dC974376DeB6272f24e53'], ['0xD7217E5687FF1071356C780b5fe4803D9D967da7']),
  747474: chain(747474, 'Katana', '0xD50F2DffFd62f94Ee4AEd9ca05C61d0753268aBc',
    ['0x1c8De6889acee12257899BFeAa2b7e534de32E16'], ['0xFcb8b57E56787bB29e130Fca67f3c5a1232975D1']),
  143: chain(143, 'Monad', '0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee',
    ['0x33f20973275B2F574488b18929cd7DCBf1AbF275'], ['0x8B2F922162FBb60A6a072cC784A2E4168fB0bb0c']),
  4663: chain(4663, 'Robinhood Chain', '0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010',
    [], ['0x0FBad98595b0186dA120E41f77C102beb49f803c']),
})

export const MORPHO_CHAIN_IDS: readonly string[] = Object.freeze(Object.keys(MORPHO_CHAINS).map((id) => `eip155:${id}`))

/** Default Morpho API endpoint (decoration and discovery only; no key, 750 req/min). */
export const MORPHO_API = 'https://api.morpho.org/graphql'

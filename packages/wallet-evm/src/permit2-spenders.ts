/**
 * The spenders a Permit2 grant may name without a `spender-unknown` warning: Uniswap's Universal Router
 * deployments, per chain, and nothing else. The router moves Permit2 funds only for the account that calls
 * it, so a grant to it is spendable by its signer alone; that holds for no other address, which is why the
 * list is not a general "known contracts" registry.
 *
 * Sources (read 2026-11-10), named in each entry's `source`, joined with `+` when several list the address:
 * - `repo`    — github.com/Uniswap/universal-router, `deploy-addresses/<chain>.json` at commit 3be05ae0
 * - `sdk`     — github.com/Uniswap/sdks, `sdks/universal-router-sdk/src/utils/constants.ts` at commit 8ae0425c
 * - `docs-v4` — github.com/Uniswap/docs, `content/protocols/v4/deployments.mdx` at commit 338d7098
 * - `docs-v3` — same repository and commit, `content/protocols/v3/deployments/v3-<chain>-deployments.mdx`
 *
 * `version` is the router build the source names (1.2, 2.0, 2.1.1, 2.1.2, 2.2.0); `unversioned` is an
 * address only the documentation lists, with no build name. Every version the SDK's table or the
 * documentation lists for a chain is here: wallets meet signatures for older routers as long as front ends
 * still use them. Builds the repository files list but neither the SDK table nor the documentation does
 * (the first `UniversalRouterV1`, the `NoV2Support` variants) are left out.
 *
 * Each entry was checked on-chain on 2026-11-10 through public RPCs: the endpoint answers with the chain
 * id, the address has code, `execute(bytes,bytes[])` accepts an empty program and reverts with
 * `LengthMismatch()` on one command without input, and Permit2 has code on that chain. An address that is
 * not in an official source, or did not pass, is not listed. Chains with no entry have no Universal Router
 * in those sources.
 */

/** Permit2, the same address on every chain. */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

/** The label {@link permit2KnownSpender} gives a listed router. */
export const UNISWAP_UNIVERSAL_ROUTER_LABEL = 'Uniswap Universal Router'

/** One pinned Universal Router deployment. */
export interface UniversalRouterDeployment {
  /** The router, EIP-55 checksummed. */
  address: string
  /** The build the source names, or `unversioned` when only the documentation lists the address. */
  version: '1.2' | '2.0' | '2.1.1' | '2.1.2' | '2.2.0' | 'unversioned'
  /** Where the address comes from: `repo`, `sdk`, `docs-v4`, `docs-v3`, joined with `+`. */
  source: string
}

const ROUTERS: Record<number, UniversalRouterDeployment[]> = {
  // Ethereum
  1: [
    { address: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', version: '1.2', source: 'repo+sdk' },
    { address: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af', version: '2.0', source: 'docs-v4+docs-v3+repo+sdk' },
    { address: '0x4C82D1fBFe28C977cBB58D8C7FF8FCF9F70a2cCA', version: '2.1.1', source: 'docs-v4+repo+sdk' },
    { address: '0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85', version: '2.1.2', source: 'repo+sdk' },
    { address: '0xab863E752Bf67D8DCDD929EaAe9Be9dc83Fb3BbB', version: '2.2.0', source: 'sdk' },
  ],
  // Base
  8453: [
    { address: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', version: '1.2', source: 'repo+sdk' },
    { address: '0x6fF5693b99212Da76ad316178A184AB56D299b43', version: '2.0', source: 'docs-v4+docs-v3+repo+sdk' },
    { address: '0xFdf682F51FE81Aa4898F0AE2163d8A55c127fbC7', version: '2.1.1', source: 'docs-v4+repo+sdk' },
    { address: '0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40', version: '2.1.2', source: 'repo+sdk' },
    { address: '0xBE2257d1aAfBE6B73F67A9ac971C2F0B344Bb3c5', version: '2.2.0', source: 'sdk' },
  ],
  // BNB Chain
  56: [
    { address: '0x4Dae2f939ACf50408e13d58534Ff8c2776d45265', version: '1.2', source: 'repo+sdk' },
    { address: '0x1906c1d672b88cD1B9aC7593301cA990F94Eae07', version: '2.0', source: 'docs-v4+docs-v3+repo+sdk' },
    { address: '0x8B844f885672f333Bc0042cB669255f93a4C1E6b', version: '2.1.1', source: 'docs-v4+repo+sdk' },
    { address: '0xDc264714F68d84CF29BC605589405E78bDBE7C9f', version: '2.1.2', source: 'repo+sdk' },
  ],
  // Arbitrum
  42161: [
    { address: '0x5E325eDA8064b456f4781070C0738d849c824258', version: '1.2', source: 'repo+sdk' },
    { address: '0xA51afAFe0263b40EdaEf0Df8781eA9aa03E381a3', version: '2.0', source: 'docs-v4+docs-v3+repo+sdk' },
    { address: '0x8B844f885672f333Bc0042cB669255f93a4C1E6b', version: '2.1.1', source: 'docs-v4+repo+sdk' },
    { address: '0x2d01411773c8C24805306E89A41F7855C3c4Fe65', version: '2.1.2', source: 'repo+sdk' },
  ],
  // Optimism
  10: [
    { address: '0xCb1355ff08Ab38bBCE60111F1bb2B784bE25D7e8', version: '1.2', source: 'repo+sdk' },
    { address: '0x851116D9223fabED8E56C0E6b8Ad0c31d98B3507', version: '2.0', source: 'docs-v4+docs-v3+repo+sdk' },
    { address: '0x8B844f885672f333Bc0042cB669255f93a4C1E6b', version: '2.1.1', source: 'docs-v4+repo+sdk' },
    { address: '0xC09255D86DB563cBc11C2fCf4a0C512e160111B4', version: '2.1.2', source: 'repo+sdk' },
  ],
  // Polygon
  137: [
    { address: '0xec7BE89e9d109e7e3Fec59c222CF297125FEFda2', version: '1.2', source: 'repo+sdk' },
    { address: '0x1095692A6237d83C6a72F3F5eFEdb9A670C49223', version: '2.0', source: 'docs-v4+docs-v3+repo+sdk' },
    { address: '0x8B844f885672f333Bc0042cB669255f93a4C1E6b', version: '2.1.1', source: 'docs-v4+repo+sdk' },
    { address: '0xDc264714F68d84CF29BC605589405E78bDBE7C9f', version: '2.1.2', source: 'repo+sdk' },
  ],
  // Avalanche
  43114: [
    { address: '0x4Dae2f939ACf50408e13d58534Ff8c2776d45265', version: '1.2', source: 'repo+sdk' },
    { address: '0x94b75331AE8d42C1b61065089B7d48FE14aA73b7', version: '2.0', source: 'docs-v4+docs-v3+sdk' },
    { address: '0x8B844f885672f333Bc0042cB669255f93a4C1E6b', version: '2.1.1', source: 'docs-v4+repo+sdk' },
    { address: '0x661E93cca42AfacB172121EF892830cA3b70F08d', version: '2.1.2', source: 'repo+sdk' },
  ],
  // HyperEVM
  999: [
    { address: '0xeD270A1Bcdc63cf1356D695e7f40961d4819d6bF', version: '2.1.2', source: 'repo' },
    { address: '0xE783DE89a7F0408687f051e3E6D0BEb62719EbAd', version: '2.2.0', source: 'repo' },
  ],
  // Robinhood Chain
  4663: [
    { address: '0x8876789976dEcBfCbBbe364623C63652db8C0904', version: '2.1.1', source: 'docs-v4+docs-v3+repo+sdk' },
    { address: '0x204FAca1764B154221e35c0d20aBb3c525710498', version: '2.1.2', source: 'repo+sdk' },
  ],
  // zkSync Era
  324: [
    { address: '0x28731BCC616B5f51dD52CF2e4dF0E78dD1136C06', version: '1.2', source: 'docs-v3+sdk' },
  ],
  // Celo
  42220: [
    { address: '0x643770E279d5D0733F21d6DC03A8efbABf3255B4', version: '1.2', source: 'docs-v3+repo+sdk' },
    { address: '0xcb695bc5D3Aa22cAD1E6DF07801b061a05A0233A', version: '2.0', source: 'docs-v4+sdk' },
    { address: '0x8B844f885672f333Bc0042cB669255f93a4C1E6b', version: '2.1.1', source: 'docs-v4+repo+sdk' },
    { address: '0xe2023F3FA515cF070e07fD9d51c1d236e07843f4', version: '2.1.2', source: 'repo+sdk' },
  ],
  // MegaETH
  4326: [
    { address: '0x48fD03529D2a91bE835f07f6b72f53b4Aad6093D', version: '2.0', source: 'repo+sdk' },
    { address: '0x47837eB80DB5908EabbA9105626D9B348bea7B02', version: 'unversioned', source: 'docs-v4+docs-v3' },
    { address: '0xAedd1CF4C14e833140A61E9C0d2b73a64795c823', version: '2.1.2', source: 'repo+sdk' },
  ],
  // Unichain
  130: [
    { address: '0x4D73A4411CA1c660035e4AECC8270E5DdDEC8C17', version: '1.2', source: 'sdk' },
    { address: '0xEf740bf23aCaE26f6492B10de645D6B98dC8Eaf3', version: '2.0', source: 'docs-v4+repo+sdk' },
    { address: '0xFdf682F51FE81Aa4898F0AE2163d8A55c127fbC7', version: '2.1.1', source: 'docs-v4+repo+sdk' },
    { address: '0xD1b797D92d87B688193A2B976eFc8D577D204343', version: '2.1.2', source: 'repo+sdk' },
  ],
  // Monad
  143: [
    { address: '0x0D97Dc33264bfC1c226207428A79b26757fb9dc3', version: '2.0', source: 'docs-v4+docs-v3+sdk' },
    { address: '0xFdf682F51FE81Aa4898F0AE2163d8A55c127fbC7', version: '2.1.1', source: 'docs-v4+repo+sdk' },
    { address: '0xa6CE4F10d83dBdDAc17E68e1837ca9cE6a1b596e', version: '2.1.2', source: 'repo+sdk' },
  ],
  // Linea
  59144: [
    { address: '0x661E93cca42AfacB172121EF892830cA3b70F08d', version: '2.0', source: 'sdk' },
    { address: '0x8B844f885672f333Bc0042cB669255f93a4C1E6b', version: '2.1.1', source: 'repo+sdk' },
    { address: '0xDc264714F68d84CF29BC605589405E78bDBE7C9f', version: '2.1.2', source: 'repo+sdk' },
  ],
  // World Chain
  480: [
    { address: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', version: '1.2', source: 'repo+sdk' },
    { address: '0x8ac7bEE993bb44dAb564Ea4bc9EA67Bf9Eb5e743', version: '2.0', source: 'docs-v4+docs-v3+repo+sdk' },
    { address: '0x8B844f885672f333Bc0042cB669255f93a4C1E6b', version: '2.1.1', source: 'docs-v4+repo+sdk' },
    { address: '0xF025e0Fe9E331A0eF05c2ad3C4E9C64b625cda6f', version: '2.1.2', source: 'repo+sdk' },
  ],
  // Ink
  57073: [
    { address: '0x112908daC86e20e7241B0927479Ea3Bf935d1fa0', version: '2.0', source: 'docs-v4+repo+sdk' },
    { address: '0x661E93cca42AfacB172121EF892830cA3b70F08d', version: '2.1.2', source: 'repo+sdk' },
    { address: '0x315e413A11AB0df498eF83873012430ca36638Ae', version: '2.2.0', source: 'sdk' },
  ],
  // X Layer
  196: [
    { address: '0x5507749F2c558Bb3E162c6e90c314c092E7372Ff', version: '2.0', source: 'sdk' },
    { address: '0xDa00aE15d3A71466517129255255db7c0c0956d3', version: 'unversioned', source: 'docs-v4' },
    { address: '0x8B844f885672f333Bc0042cB669255f93a4C1E6b', version: '2.1.1', source: 'docs-v4+repo+sdk' },
    { address: '0x1cd182C94fcF42277B80DBB9060F88024809E61E', version: '2.1.2', source: 'repo+sdk' },
  ],
  // Arc
  5042: [
    { address: '0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1', version: '2.1.1', source: 'repo+sdk' },
    { address: '0x8702463e73f74d0b6765aBceb314Ef07aCb92650', version: '2.1.2', source: 'repo+sdk' },
  ],
}

function deepFreeze(table: Record<number, UniversalRouterDeployment[]>): Readonly<Record<number, readonly Readonly<UniversalRouterDeployment>[]>> {
  for (const list of Object.values(table)) {
    for (const entry of list) Object.freeze(entry)
    Object.freeze(list)
  }
  return Object.freeze(table)
}

// The lookup is built once, before the table is handed out: what a caller does to the export changes nothing.
const BY_CHAIN: ReadonlyMap<number, ReadonlySet<string>> = new Map(
  Object.entries(ROUTERS).map(([chain, list]) => [Number(chain), new Set(list.map((e) => e.address.toLowerCase()))] as const),
)

/** Uniswap Universal Router deployments by EVM chain id (frozen). See the file header for sources and checks. */
export const UNISWAP_UNIVERSAL_ROUTERS = deepFreeze(ROUTERS)

/**
 * The label of a spender a Permit2 grant signed for `chainId` may name without a warning — a Universal
 * Router deployed on that chain — or undefined. The same address on another chain is not known.
 */
export function permit2KnownSpender(chainId: number | undefined, spender: string): string | undefined {
  if (chainId === undefined || typeof spender !== 'string') return undefined
  return BY_CHAIN.get(chainId)?.has(spender.toLowerCase()) ? UNISWAP_UNIVERSAL_ROUTER_LABEL : undefined
}

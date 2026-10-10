// Aave v3 markets, from the official address book (bgd-labs/aave-address-book,
// `src/AaveV3*.sol`, read 2026-10-10). The module only *needs* the
// PoolAddressesProvider: the Pool, oracle and data provider are read from it
// on-chain, and the preset's `pool` is cross-checked against that answer so a
// stale or wrong entry refuses instead of sending money to the wrong contract.
import type { Address } from 'viem'

export interface AaveMarket {
  /** Preset key: 'core' on every chain, plus 'lido' / 'etherfi' on Ethereum. */
  key: string
  /** Human name as the address book calls it. */
  name: string
  chainId: number
  addressesProvider: Address
  pool: Address
  /** AaveProtocolDataProvider — informational, the module reads the Pool directly. */
  dataProvider: Address
  /** WrappedTokenGatewayV3 for the chain's native coin; absent where Aave deployed none (Celo, Metis). */
  wethGateway?: Address
}

const market = (chainId: number, key: string, name: string, addressesProvider: Address, pool: Address, dataProvider: Address, wethGateway?: Address): AaveMarket =>
  wethGateway ? { key, name, chainId, addressesProvider, pool, dataProvider, wethGateway } : { key, name, chainId, addressesProvider, pool, dataProvider }

/** chainId → preset key → market. */
export const AAVE_MARKETS: Readonly<Record<number, Readonly<Record<string, AaveMarket>>>> = Object.freeze({
  1: {
    core: market(1, 'core', 'Aave V3 Ethereum', '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e', '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', '0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD', '0xd01607c3C5eCABa394D8be377a08590149325722'),
    lido: market(1, 'lido', 'Aave V3 Ethereum Lido', '0xcfBf336fe147D643B9Cb705648500e101504B16d', '0x4e033931ad43597d96D6bcc25c280717730B58B1', '0xB85B2bFEbeC4F5f401dbf92ac147A3076391fCD5', '0x3167C452fA3fa1e5C16bB83Bc0fde4519C464299'),
    etherfi: market(1, 'etherfi', 'Aave V3 Ethereum EtherFi', '0xeBa440B438Ad808101d1c451C1C5322c90BEFCdA', '0x0AA97c284e98396202b6A04024F5E2c65026F3c0', '0x7c8509591f9693D21280d96e149a08A3bf69Cd0c', '0xf956B38F035dC9067fb827A512D3CF35202AB0Bc'),
  },
  10: { core: market(10, 'core', 'Aave V3 Optimism', '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb', '0x794a61358D6845594F94dc1DB02A252b5b4814aD', '0x243Aa95cAC2a25651eda86e80bEe66114413c43b', '0x5f2508cAE9923b02316254026CD43d7902866725') },
  56: { core: market(56, 'core', 'Aave V3 BNB', '0xff75B6da14FfbbfD355Daf7a2731456b3562Ba6D', '0x6807dc923806fE8Fd134338EABCA509979a7e0cB', '0xc90Df74A7c16245c5F5C5870327Ceb38Fe5d5328', '0x0c2C95b24529664fE55D4437D7A31175CFE6c4f7') },
  100: { core: market(100, 'core', 'Aave V3 Gnosis', '0x36616cf17557639614c1cdDb356b1B83fc0B2132', '0xb50201558B00496A145fE76f7424749556E326D8', '0xF1F5acB596568895393cB5E4D0452D6592A2fA70', '0x721B9abAb6511b46b9ee83A1aba23BDAcB004149') },
  137: { core: market(137, 'core', 'Aave V3 Polygon', '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb', '0x794a61358D6845594F94dc1DB02A252b5b4814aD', '0x243Aa95cAC2a25651eda86e80bEe66114413c43b', '0xBC302053db3aA514A3c86B9221082f162B91ad63') },
  146: { core: market(146, 'core', 'Aave V3 Sonic', '0x5C2e738F6E27bCE0F7558051Bf90605dD6176900', '0x5362dBb1e601abF3a4c14c22ffEdA64042E5eAA3', '0xc0a344397cfa89dF1e1d3e4fb330834D789cF2CD', '0x061D8e131F26512348ee5FA42e2DF1bA9d6505E9') },
  324: { core: market(324, 'core', 'Aave V3 ZkSync', '0x2A3948BB219D6B2Fa83D64100006391a96bE6cb7', '0x78e30497a3c7527d953c6B1E3541b021A98Ac43c', '0x9057ac7b2D35606F8AD5aE2FCBafcD94E58D9927', '0xAE2b00D676130Bdf22582781BbBA8f4F21e8B0ff') },
  1088: { core: market(1088, 'core', 'Aave V3 Metis', '0xB9FABd7500B2C6781c35Dd48d54f81fc2299D7AF', '0x90df02551bB792286e8D4f13E0e357b4Bf1D6a57', '0x602BeF1d4c381e5a29f0C562A310416A73D8Be19') },
  1868: { core: market(1868, 'core', 'Aave V3 Soneium', '0x82405D1a189bd6cE4667809C35B37fBE136A4c5B', '0xDd3d7A7d03D9fD9ef45f3E587287922eF65CA38B', '0x4a24b44b252db149B5B9BCec4dc3c2752807d626', '0x6376D4df995f32f308f2d5049a7a320943023232') },
  5000: { core: market(5000, 'core', 'Aave V3 Mantle', '0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f', '0x458F293454fE0d67EC0655f3672301301DD51422', '0x487c5c669D9eee6057C44973207101276cf73b68', '0x9C6cCAC66b1c9AbA4855e2dD284b9e16e41E06eA') },
  8453: { core: market(8453, 'core', 'Aave V3 Base', '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D', '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', '0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A', '0xa0d9C1E9E48Ca30c8d8C3B5D69FF5dc1f6DFfC24') },
  9745: { core: market(9745, 'core', 'Aave V3 Plasma', '0x061D8e131F26512348ee5FA42e2DF1bA9d6505E9', '0x925a2A7214Ed92428B5b1B090F80b25700095e12', '0xf2D6E38B407e31E7E7e4a16E6769728b76c7419F', '0x54BDcc37c4143f944A3EE51C892a6cBDF305E7a0') },
  42161: { core: market(42161, 'core', 'Aave V3 Arbitrum', '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb', '0x794a61358D6845594F94dc1DB02A252b5b4814aD', '0x243Aa95cAC2a25651eda86e80bEe66114413c43b', '0x5283BEcEd7ADF6D003225C13896E536f2D4264FF') },
  42220: { core: market(42220, 'core', 'Aave V3 Celo', '0x9F7Cf9417D5251C59fE94fB9147feEe1aAd9Cea5', '0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402', '0x2e0f8D3B1631296cC7c56538D6Eb6032601E15ED') },
  43114: { core: market(43114, 'core', 'Aave V3 Avalanche', '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb', '0x794a61358D6845594F94dc1DB02A252b5b4814aD', '0x243Aa95cAC2a25651eda86e80bEe66114413c43b', '0x2825cE5921538d17cc15Ae00a8B24fF759C6CDaE') },
  57073: { core: market(57073, 'core', 'Aave V3 Ink (whitelabel)', '0x4172E6aAEC070ACB31aaCE343A58c93E4C70f44D', '0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA', '0x96086C25d13943C80Ff9a19791a40Df6aFC08328', '0xDe090EfCD6ef4b86792e2D84E55a5fa8d49D25D2') },
  59144: { core: market(59144, 'core', 'Aave V3 Linea', '0x89502c3731F69DDC95B65753708A07F8Cd0373F4', '0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac', '0x47cd4b507B81cB831669c71c7077f4daF6762FF4', '0x31A239f3e39c5D8BA6B201bA81ed584492Ae960F') },
  534352: { core: market(534352, 'core', 'Aave V3 Scroll', '0x69850D0B276776781C063771b161bd8894BCdD04', '0x11fCfe756c05AD438e312a7fd934381537D3cFfe', '0xBEa2B648f05887eCbF1d115da8b7E4A317975A51', '0xE79Ca44408Dae5a57eA2a9594532f1E84d2edAa4') },
})

/** Every known market as a flat list. */
export function listMarkets(): AaveMarket[] {
  return Object.values(AAVE_MARKETS).flatMap((byKey) => Object.values(byKey))
}

/** CAIP-2 ids of every chain with a known market (for module.json / capability checks). */
export const AAVE_CHAINS: readonly string[] = Object.freeze(Object.keys(AAVE_MARKETS).map((id) => `eip155:${id}`))

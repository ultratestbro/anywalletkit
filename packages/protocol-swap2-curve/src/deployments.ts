import type {Hex} from "./pools/types.js";

/**
 * Curve Router NG deployments this module trusts, one per chain, keyed by chain id (the same address means a different
 * contract on another chain: `0x4f37…fc1F` is a `[5][5]` router on Base and a `[4][5]` one on Mantle). Every entry was
 * read on-chain on 2026-11-05: the runtime code's keccak (the router has no owner and no proxy; its immutables — the
 * wrapped native, and on `[5][5]` routers the two calc zaps — are inside the code, so the hash pins them too),
 * `version()`, the wrapped native read from the code's immutable tail, and what the chain's AddressProvider lists as
 * id 2. The provider re-checks the code hash and the version once per chain before quoting (`verifyDeployment`).
 *
 * The router address is never resolved at runtime: the AddressProvider is an informational registry its admin (an
 * individual, not the DAO) can change at any time, so its id 2 is only compared and a difference only warned about.
 */

/** ABI family of a router: `ng5` = `uint256[5][5]` swap params `[i, j, swap_type, pool_type, n_coins]` plus a
 *  `_pools[5]` argument (curve-router-ng `Router.vy`); `lite4` = `uint256[4][5]` `[i, j, swap_type, pool_type]`, no
 *  `_pools` (curve-core `router_v_110.vy` / `router_v_111.vy`, NG pools only). */
export type CurveRouterFamily = "ng5" | "lite4";

export interface CurveDeployment {
  /** Human label for logs and subtitles. */
  label: string;
  family: CurveRouterFamily;
  router: Hex;
  /** `version()` as the router reports it. */
  version: "1.2.0" | "1.1.0" | "1.1.1";
  /** keccak256 of the router's runtime code. */
  codeHash: Hex;
  /** The wrapped native the router's swap_type 8 hop wraps / unwraps (its `WETH_ADDRESS` immutable). */
  weth: Hex;
  /** The router's native sentinel (`ETH_ADDRESS`; a constructor immutable on v1.1.1). */
  eth: Hex;
  /** The chain's Curve AddressProvider (watch signal only) and the address its id 2 listed when pinned. */
  addressProvider: Hex;
  addressProviderRouter: Hex;
  /** ERC-4626 pseudo-hop (swap_type 9) the router may use — only on router v1.2 (Ethereum: crvUSD ↔ scrvUSD). */
  erc4626?: {vault: Hex; asset: Hex};
}

/** The native sentinel every pinned router uses (checked against the v1.1.1 routers' immutable). */
export const CURVE_ETH: Hex = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const ZERO_ADDRESS: Hex = "0x0000000000000000000000000000000000000000";
/** Most pool hops one route crosses (pseudo-hops — wrap, ERC-4626 — come on top). */
export const MAX_ROUTE_POOLS = 2;
/** Most router steps one route may have: two pools, a wrap in front and an unwrap or an ERC-4626 hop behind. */
export const MAX_ROUTE_STEPS = 4;

/** Savings crvUSD (Yearn V3 vault, ERC-4626 over crvUSD) on Ethereum, and crvUSD itself. */
export const SCRVUSD: Hex = "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367";
export const CRVUSD_ETHEREUM: Hex = "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E";

const AP: Hex = "0x5ffe7FB82894076ECB99A30D6A32e969e6e35E98";
const R_OP_POLY_GNO_AVAX: Hex = "0x0DCDED3545D565bA3B19E683431381007245d983";
const R_UNI_HYPER: Hex = "0xd2002373543Ce3527023C75e7518C274A51ce712";
const R_MONAD_PLASMA_RH: Hex = "0xFF5Cb29241F002fFeD2eAa224e3e996D24A6E8d1";
const R_BASE_MANTLE: Hex = "0x4f37A9d177470499A2dD084621020b023fcffc1F";
const AP_UNI_HYPER: Hex = "0x1764ee18e8B3ccA4787249Ceb249356192594585";
const AP_MONAD_PLASMA_RH: Hex = "0x4574921eb950d3Fd5B01562162EC566Cb8bc3648";
const OP_WETH: Hex = "0x4200000000000000000000000000000000000006";

const d = (o: Omit<CurveDeployment, "eth"> & {eth?: Hex}): CurveDeployment => Object.freeze({eth: CURVE_ETH, ...o});

export const CURVE_DEPLOYMENTS: Readonly<Record<number, CurveDeployment>> = Object.freeze({
  // [5][5] routers. Ethereum runs v1.2 (the router Curve's UI, curve-js and the curve-router-ng README use; the only one
  // with the ERC-4626 hop) — the AddressProvider still lists v1.1 there.
  1: d({label: "Ethereum", family: "ng5", router: "0x45312ea0eFf7E09C83CBE249fa1d7598c4C8cd4e", version: "1.2.0", codeHash: "0xbe5f7301254e95d27c6aa1be0fedc0aa04d6c36097e089bc9d2cccaa9d26b164", weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", addressProvider: AP, addressProviderRouter: "0x16C6521Dff6baB339122a0FE25a9116693265353", erc4626: {vault: SCRVUSD, asset: CRVUSD_ETHEREUM}}),
  42161: d({label: "Arbitrum", family: "ng5", router: "0x2191718CD32d02B8E60BAdFFeA33E4B5DD9A0A0D", version: "1.1.0", codeHash: "0x9b387b5dc8fe161c7af8e850a67662e93d7116b0e66ab6bc7761d5910093bcef", weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", addressProvider: AP, addressProviderRouter: "0x2191718CD32d02B8E60BAdFFeA33E4B5DD9A0A0D"}),
  8453: d({label: "Base", family: "ng5", router: R_BASE_MANTLE, version: "1.1.0", codeHash: "0x3abb7fe467b6c925ab1b25771cf1c75cc507aec2f873a8d03ee95160c5a83579", weth: OP_WETH, addressProvider: AP, addressProviderRouter: R_BASE_MANTLE}),
  10: d({label: "OP Mainnet", family: "ng5", router: R_OP_POLY_GNO_AVAX, version: "1.1.0", codeHash: "0x12ae037c1e9a21aeb6ba1b08863217de2babebbee58dbe8860a01ded6a974825", weth: OP_WETH, addressProvider: AP, addressProviderRouter: R_OP_POLY_GNO_AVAX}),
  137: d({label: "Polygon", family: "ng5", router: R_OP_POLY_GNO_AVAX, version: "1.1.0", codeHash: "0x340f3ba3f30181c50e694f1a4da2f6ec670fc7eb0adce50d66a733f17ab150f4", weth: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", addressProvider: AP, addressProviderRouter: R_OP_POLY_GNO_AVAX}),
  100: d({label: "Gnosis", family: "ng5", router: R_OP_POLY_GNO_AVAX, version: "1.1.0", codeHash: "0x38dc1cc456be010539e596d2ee0aa82c271316bdc6daaaffea7990a0c47176ee", weth: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", addressProvider: AP, addressProviderRouter: R_OP_POLY_GNO_AVAX}),
  43114: d({label: "Avalanche", family: "ng5", router: R_OP_POLY_GNO_AVAX, version: "1.1.0", codeHash: "0xf1f679ec6382cd9c0138870e320e6128193f75144501691e67dcd5831edaed2b", weth: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", addressProvider: AP, addressProviderRouter: R_OP_POLY_GNO_AVAX}),
  56: d({label: "BNB Chain", family: "ng5", router: "0xA72C85C258A81761433B4e8da60505Fe3Dd551CC", version: "1.1.0", codeHash: "0x19db989a1cca08711ff68049326a5a7a8d1f64d87f356d35243150215c722120", weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", addressProvider: AP, addressProviderRouter: "0xA72C85C258A81761433B4e8da60505Fe3Dd551CC"}),
  // [4][5] routers (curve-core, NG pools only, no swap_type 9).
  146: d({label: "Sonic", family: "lite4", router: "0x5eeE3091f747E60a045a2E715a4c71e600e31F6E", version: "1.1.0", codeHash: "0xc5f238aee45c18efc927708fe57821cca4a84ec1bff4f22e778dfcd108411b99", weth: "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38", addressProvider: "0x87FE17697D0f14A222e8bEf386a0860eCffDD617", addressProviderRouter: "0x5eeE3091f747E60a045a2E715a4c71e600e31F6E"}),
  130: d({label: "Unichain", family: "lite4", router: R_UNI_HYPER, version: "1.1.0", codeHash: "0xe911928fab7efb72e10ee3a918dcdfb44ac5bae1c4d46eb5534bea0259d2594c", weth: OP_WETH, addressProvider: AP_UNI_HYPER, addressProviderRouter: R_UNI_HYPER}),
  999: d({label: "HyperEVM", family: "lite4", router: R_UNI_HYPER, version: "1.1.0", codeHash: "0x1040124f623348643d919029ed513670cdb825bd0135f846ce9028329d8eb77d", weth: "0x5555555555555555555555555555555555555555", addressProvider: AP_UNI_HYPER, addressProviderRouter: R_UNI_HYPER}),
  5000: d({label: "Mantle", family: "lite4", router: R_BASE_MANTLE, version: "1.1.0", codeHash: "0xe76d585fb4163cd886c99f1c12361c5644e18b8dab2d86e3fe223307e7a16f29", weth: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8", addressProvider: AP, addressProviderRouter: R_BASE_MANTLE}),
  143: d({label: "Monad", family: "lite4", router: R_MONAD_PLASMA_RH, version: "1.1.0", codeHash: "0x7668fc406894fb811ab7f9a1099f2e33ef8d80f58327e623bbe4c4d51e406f58", weth: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", addressProvider: AP_MONAD_PLASMA_RH, addressProviderRouter: R_MONAD_PLASMA_RH}),
  9745: d({label: "Plasma", family: "lite4", router: R_MONAD_PLASMA_RH, version: "1.1.0", codeHash: "0xeede894a379cb95c73ece834e836ff9bbaa1ff613fb7913d0cbc3a48b2897120", weth: "0x6100E367285b01F48D07953803A2d8dCA5D19873", addressProvider: AP_MONAD_PLASMA_RH, addressProviderRouter: R_MONAD_PLASMA_RH}),
  // v1.1.1: ETH_ADDRESS is a constructor immutable — 0xEeee… here, read from the code tail with WETH_ADDRESS.
  4663: d({label: "Robinhood Chain", family: "lite4", router: R_MONAD_PLASMA_RH, version: "1.1.1", codeHash: "0x716ad3720f54c96effe415598d3a62b9907e53c58c7e3d3004cba6cdb5c297a6", weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", eth: CURVE_ETH, addressProvider: AP_MONAD_PLASMA_RH, addressProviderRouter: R_MONAD_PLASMA_RH}),
  57073: d({label: "Ink", family: "lite4", router: "0xd7E72f3615aa65b92A4DBdC211E296a35512988B", version: "1.1.0", codeHash: "0x511c1733063263ba386b0e6b01b51d777deb02ea1b6e75fcde1e572e47f22436", weth: OP_WETH, addressProvider: "0x604388Bb1159AFd21eB5191cE22b4DeCdEE2Ae22", addressProviderRouter: "0xd7E72f3615aa65b92A4DBdC211E296a35512988B"}),
  196: d({label: "X Layer", family: "lite4", router: "0xBFab8ebc836E1c4D81837798FC076D219C9a1855", version: "1.1.0", codeHash: "0xfc0a3b12868c10a8a46e33f17504f8751c83d3842f715c665c3d827bfc4ed625", weth: "0xe538905cf8410324e03A5A23C1c177a474D59b2b", addressProvider: AP, addressProviderRouter: "0xBFab8ebc836E1c4D81837798FC076D219C9a1855"}),
  98866: d({label: "Plume", family: "lite4", router: "0x3F5A41B922a76759b9C77D36b3d337E88cD1dc5e", version: "1.1.0", codeHash: "0x0819b95039f1e0ac56aefffc8a727e996b3afa831fd3bb2047a3737bf23ab5e4", weth: "0xEa237441c92CAe6FC17Caaf9a7acB3f953be4bd1", addressProvider: "0x907CE289E9Ee0BBcb0F69132B1C28A9Affc29FCA", addressProviderRouter: "0x3F5A41B922a76759b9C77D36b3d337E88cD1dc5e"}),
});

/**
 * Older Ethereum routers recognized in history only (never quoted or approved): Router NG v1.1 (what the
 * AddressProvider lists as id 2) and v1.0. Both `[5][5]`, both immutable (checked 2026-11-05).
 */
export const CURVE_LEGACY_ROUTERS: Readonly<Record<number, readonly {router: Hex; version: string; codeHash: Hex}[]>> = Object.freeze({
  1: Object.freeze([
    {router: "0x16C6521Dff6baB339122a0FE25a9116693265353" as Hex, version: "1.1.0", codeHash: "0xf041e5b17dc8b2c417a9561eb265145e442ab25b789d9bd3527c6b68a840577b" as Hex},
    {router: "0xF0d4c12A5768D806021F80a262B4d39d26C58b8D" as Hex, version: "1.0.0", codeHash: "0xdfc206a29f04b4cee5b7b8d5b60ffcd2574fc9ff17cc5ec00c58b17013ea3f3b" as Hex},
  ]),
});

/**
 * Pools a route never crosses, whatever an allowlist says (defense in depth, Ethereum): a registered stable-ng pool
 * pairing real USDT with a token that calls itself "USDT" (`0x810e…ae9`), and the three factory pools drained by the
 * 2023 Vyper reentrancy-lock bug (alETH, pETH, msETH — still registered on-chain).
 */
export const CURVE_DENIED_POOLS: Readonly<Record<number, ReadonlySet<string>>> = Object.freeze({
  1: new Set([
    "0xa6d9f4f3a67b35e81dfa560b0fcde9b0751f1f53",
    "0xc4c319e2d4d66cca4464c0c2b32c9bd23ebe784e",
    "0x9848482da3ee3076165ce6497eda906e66bb85c5",
    "0xc897b98272aa23714464ea2a0bd5180f1b8c0025",
  ]),
});

/** The chain id of an `eip155:<id>` CAIP-2 string, or NaN. */
export function chainIdOf(caip2: string): number {
  return /^eip155:[0-9]+$/.test(caip2) ? Number(caip2.slice(7)) : NaN;
}

/** The deployment pinned for `chainId` in `table` (own keys only), or undefined. */
export function deploymentOf(table: Readonly<Record<number, CurveDeployment>>, chainId: number): CurveDeployment | undefined {
  return Object.prototype.hasOwnProperty.call(table, chainId) ? table[chainId] : undefined;
}

import {parseAbi, parseAbiParameters} from "viem";

/**
 * Uniswap v4 deployments this module trusts, and the byte values of the Universal Router 2.1.x it writes for.
 *
 * Source: Uniswap's `developers.uniswap.org/deployments.json` (generatedAt 2026-11-09T21:49:59Z, Uniswap/contracts
 * `3b872969`), each row checked on chain on 2026-11-25 (21:02–21:14Z, re-checked 21:27–21:38Z): code present at every
 * address; `poolManager()` of the V4Quoter, the StateView and the Universal Router equal to the PoolManager; the router
 * is the `UniversalRouter#v2.1.2` build (24,380 bytes; its immutables — WETH9, Permit2, PoolManager, v4 PositionManager —
 * decoded from the bytecode and equal to the repo deploy script); the SwapProxy is the 1,005-byte build whose codehash is
 * {@link SWAP_PROXY_CODEHASH} on every chain. The router codehash differs per chain (immutables), so it is pinned per
 * chain. Every pin is keyed by (chainId, address): the same address holds different contracts on different chains
 * (`0x661E93cc…` is UR 2.1.2 on Avalanche and Ink, UR 2.0 on Linea, our v3 QuoterV2 on Monad).
 *
 * Only the chains in the swap catalog are listed (Soneium, Tempo and Zora have v4 but are not in the catalog).
 */
export interface UniswapV4Deployment {
  poolManager: `0x${string}`;
  /** V4Quoter (not `view`: called through `eth_call`). */
  quoter: `0x${string}`;
  stateView: `0x${string}`;
  /** Not on the swap path; pinned so a call to it is recognisably not a swap. */
  positionManager: `0x${string}`;
  /** `UniversalRouter#v2.1.2`, the only UR build present and verified on every chain. */
  universalRouter: `0x${string}`;
  /** The router build, which fixes the struct layout the calldata uses (2.1.x adds `minHopPriceX36`). */
  routerBuild: "2.1.2";
  /** keccak256 of the router's runtime code on this chain. */
  routerCodehash: `0x${string}`;
  /** Uniswap's SwapProxy (token input): pulls exactly `amount` of `token` from its caller into `router`, then calls
   *  `router.execute`. Its address is per chain (Tempo, not listed, differs). */
  swapProxy: `0x${string}`;
  swapProxyCodehash: `0x${string}`;
  /** Canonical Permit2 (no flow here uses it; pinned so an approval to it is recognisably not ours). */
  permit2: `0x${string}`;
  /** keccak256 of Permit2's runtime code on this chain (it differs per chain: the EIP-712 domain is an immutable), as
   *  read on 2026-11-25 (pins-evidence.json). No flow calls Permit2; `verify:live` compares it so drift is reported.
   *  Optional for a row an integrator adds through `v4Deployments`. */
  permit2Codehash?: `0x${string}`;
  /** The chain's wrapped native token, as the router's WETH9 immutable reports it — on Celo, the CELO ERC-20 (the
   *  router's WETH9 is a stub there); null where the native coin has no wrapped form (Arc, whose native coin is USDC). */
  weth: `0x${string}` | null;
  /** false: the native coin is also an ERC-20 on this chain (Celo's CELO, Arc's USDC) — native in/out is refused, the
   *  ERC-20 is swapped instead (as the v3 table does). */
  nativeWrap?: false;
  /** false: deployed but no quotable pool (HyperEVM: no live quote, 0 Swap logs in ~30k blocks) — never quoted. */
  quotable?: false;
}

/** Permit2, canonical on every listed chain (one skeleton, EIP-712 domain separator checked). */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
/** SwapProxy runtime codehash: 1,005 bytes, no immutables, identical on all 22 v4 chains (Sourcify exact match). */
export const SWAP_PROXY_CODEHASH = "0x24a203c24b85e0994ae6aecccc2bc0c1df4e22f1b3d63f33d18bec0245867aaf" as const;
/** The canonical SwapProxy address (every listed chain; Tempo, not listed, has it at `0x02E5be68…b2a9`). */
export const SWAP_PROXY_ADDRESS = "0x0000000085E102724e78eCd2F45DC9cA239Affad" as const;

const PERMIT2 = PERMIT2_ADDRESS;
const SWAP_PROXY = SWAP_PROXY_ADDRESS;

/**
 * The v4 table (generated from the research pins, `deployments/pins.json` + `pins-evidence.json`, 2026-11-25).
 * A chain here is pinned, not enabled: the provider quotes v4 only when its `v4` option is on, and never on a chain
 * marked `quotable: false`.
 */
export const UNISWAP_V4: Readonly<Record<number, UniswapV4Deployment>> = Object.freeze({
  1: {poolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90", quoter: "0x99bd42B2B22e531f283b7F8a86dFf631EB16A9D1", stateView: "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227", positionManager: "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e", universalRouter: "0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85", routerBuild: "2.1.2", routerCodehash: "0x55e6b334152096d60367d7ab24241948b31e8d0e66adc8b81cba049a19f9d2ac", swapProxy: SWAP_PROXY, swapProxyCodehash: SWAP_PROXY_CODEHASH, permit2: PERMIT2, permit2Codehash: "0xc67d1657868aa5146eaf24fb879fb1fdec3d2d493b3683a61c9c2f4fb2851131", weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"}, // Ethereum
  10: {poolManager: "0x9a13F98Cb987694C9F086b1F5eB990EeA8264Ec3", quoter: "0xd673F731EDFe5AaF1bDa7FD43D13Bbb5150B87Ca", stateView: "0xc18a3169788F4F75A170290584ECA6395C75Ecdb", positionManager: "0x3C3Ea4B57a46241e54610e5f022E5c45859A1017", universalRouter: "0xC09255D86DB563cBc11C2fCf4a0C512e160111B4", routerBuild: "2.1.2", routerCodehash: "0xba894f04adabac264993bc9ef53287533533d1448b8c20704db67d04ef514ef2", swapProxy: SWAP_PROXY, swapProxyCodehash: SWAP_PROXY_CODEHASH, permit2: PERMIT2, permit2Codehash: "0x375714c2c948abd47bf468552c0a842d0e8002ca721efd85061a1297d6824617", weth: "0x4200000000000000000000000000000000000006"}, // Optimism
  56: {poolManager: "0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF", quoter: "0x95C086d7fE28AdD842ee220fef225a777474d781", stateView: "0xd13Dd3D6E93f276FAfc9Db9E6BB47C1180aeE0c4", positionManager: "0x7A4a5c919aE2541AeD11041A1AEeE68f1287f95b", universalRouter: "0xDc264714F68d84CF29BC605589405E78bDBE7C9f", routerBuild: "2.1.2", routerCodehash: "0xe867d0c9a826a351e9d8cefc0fa947d71a497b9ecb0395380814a064fc8465a4", swapProxy: SWAP_PROXY, swapProxyCodehash: SWAP_PROXY_CODEHASH, permit2: PERMIT2, permit2Codehash: "0x48774d936722dd7002887f307f58bcddb3eeabad39149e7dcb5c08e4ebe3310f", weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"}, // BNB Chain
  130: {poolManager: "0x1F98400000000000000000000000000000000004", quoter: "0xF885781cB68A0BE66AA2AC7eDa5Fe72Bde7dA907", stateView: "0x86e8631A016F9068C3f085fAF484Ee3F5fDee8f2", positionManager: "0x4529A01c7A0410167c5740C487A8DE60232617bf", universalRouter: "0xD1b797D92d87B688193A2B976eFc8D577D204343", routerBuild: "2.1.2", routerCodehash: "0xf5bedf4598147c1359b12f9c6b5d827e210c62c1a00ccc2702abc8039b99ee8f", swapProxy: SWAP_PROXY, swapProxyCodehash: SWAP_PROXY_CODEHASH, permit2: PERMIT2, permit2Codehash: "0x145d01cce12e7b786df3b4238520a506e69103acc347b013d7c73e50da8df591", weth: "0x4200000000000000000000000000000000000006"}, // Unichain
  137: {poolManager: "0x67366782805870060151383F4BbFF9daB53e5cD6", quoter: "0x31AB0Dea31FC0ad5A54F03cD59C896eCD067447B", stateView: "0x5eA1bD7974c8A611cBAB0bDCAFcB1D9CC9b3BA5a", positionManager: "0x1Ec2eBf4F37E7363FDfe3551602425af0B3ceef9", universalRouter: "0xDc264714F68d84CF29BC605589405E78bDBE7C9f", routerBuild: "2.1.2", routerCodehash: "0x370874a6575cc7bd5cef1d58b30d0ce5905a90a54e955695573d2e896f1e9733", swapProxy: SWAP_PROXY, swapProxyCodehash: SWAP_PROXY_CODEHASH, permit2: PERMIT2, permit2Codehash: "0xdb0dd198c1767513d04589d8b3da05423ddc97e543440f84afe0e216693af9bb", weth: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"}, // Polygon
  143: {poolManager: "0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e", quoter: "0xa222Dd357A9076d1091Ed6Aa2e16C9742dD26891", stateView: "0x77395F3b2E73aE90843717371294fa97cC419D64", positionManager: "0x5b7eC4a94fF9beDb700fb82aB09d5846972F4016", universalRouter: "0xa6CE4F10d83dBdDAc17E68e1837ca9cE6a1b596e", routerBuild: "2.1.2", routerCodehash: "0xcb07a717d70f36cf270f1a6ed44163097e4dc8acbafb1d412cdb38f46af4b421", swapProxy: SWAP_PROXY, swapProxyCodehash: SWAP_PROXY_CODEHASH, permit2: PERMIT2, permit2Codehash: "0x332f9ca0fbd282f4a9b16f5332870dc98addc5172dd5e48ab6fa7c9be3d10fa0", weth: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A"}, // Monad
  196: {poolManager: "0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32", quoter: "0x8928074CA1b241D8Ec02815881c1Af11E8bC5219", stateView: "0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990", positionManager: "0xcF1EAFC6928dC385A342E7C6491d371d2871458b", universalRouter: "0x1cd182C94fcF42277B80DBB9060F88024809E61E", routerBuild: "2.1.2", routerCodehash: "0x37640cd0c70e55679af0bbfa3ad017c904fa0bf38ec1d3b9078d9ac933bf9439", swapProxy: SWAP_PROXY, swapProxyCodehash: SWAP_PROXY_CODEHASH, permit2: PERMIT2, permit2Codehash: "0xe2fbd4d9ddf7f3f1a2b804e92988cb7075e72967945e1f4d53f72a0767b161ab", weth: "0xe538905cf8410324e03A5A23C1c177a474D59b2b"}, // X Layer
  480: {poolManager: "0xb1860D529182ac3BC1F51Fa2ABd56662b7D13f33", quoter: "0xAD02601f1bE313C952AD198c0Cbc3F87f9eE8E63", stateView: "0x51D394718bc09297262e368c1A481217FdEB71eb", positionManager: "0xC585E0f504613b5fBf874F21Af14c65260fB41fA", universalRouter: "0xF025e0Fe9E331A0eF05c2ad3C4E9C64b625cda6f", routerBuild: "2.1.2", routerCodehash: "0x2aa57ffb4c657653b6961c7e68a3f731a1d4a22cfef61cfd8b0b9372dafe1139", swapProxy: SWAP_PROXY, swapProxyCodehash: SWAP_PROXY_CODEHASH, permit2: PERMIT2, permit2Codehash: "0x45dd68d6a87380213d5c60efda3fbbbeda9f31d147a82028e062bec058c29e53", weth: "0x4200000000000000000000000000000000000006"}, // World Chain
  999: {poolManager: "0x12D4Fd9C5DeDd00ab8a0bCe2CF0167bbf94b6B1F", quoter: "0x108Bfe38532C98f8Cd8D7Ab49c9dDAa3675a1c5e", stateView: "0x1656326235cb9E34Cb58CaDe53AE30789AB32A1A", positionManager: "0x0d7Ab5B3db668128Aff6F70C4eBC71D7d4DA9bf9", universalRouter: "0xeD270A1Bcdc63cf1356D695e7f40961d4819d6bF", routerBuild: "2.1.2", routerCodehash: "0x0710561487244e5d288bd93fe4c055a4a33fd486a07e8b4c982124c57c6d3224", swapProxy: SWAP_PROXY, swapProxyCodehash: SWAP_PROXY_CODEHASH, permit2: PERMIT2, permit2Codehash: "0x10f4ff92b79ad2dca1393ef990940a13e25fb56afd1ff4a6e15853b069020da0", weth: "0x5555555555555555555555555555555555555555", quotable: false}, // HyperEVM
  4326: {poolManager: "0xaCB7e78fa05D562e0A5D3089ec896D57D057d38E", quoter: "0x94bDC671f0c35F44a1DaA53143fd1f868D1623b9", stateView: "0x726f84e1DFb8d375a365e0808282f40D52D3E4e8", positionManager: "0x9AE0921E981AAa7308f176F8d4F9129b9247C89D", universalRouter: "0xAedd1CF4C14e833140A61E9C0d2b73a64795c823", routerBuild: "2.1.2", routerCodehash: "0x914ac8c60bee9770eeeccce1a742751a1f0fdeeee4d87d0e46ca45a1c62eb10e", swapProxy: SWAP_PROXY, swapProxyCodehash: SWAP_PROXY_CODEHASH, permit2: PERMIT2, permit2Codehash: "0xf43bae2cccfa48249b809be47d3ae4a3f88750832d022b98d84cd610f608eb45", weth: "0x4200000000000000000000000000000000000006"}, // MegaETH
  4663: {poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951", quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94", stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b", positionManager: "0x58daec3116aae6D93017bAAea7749052E8a04fA7", universalRouter: "0x204FAca1764B154221e35c0d20aBb3c525710498", routerBuild: "2.1.2", routerCodehash: "0x76b92a5bba2dd32019a64eb421f1750e78c6ba044dbfa6840b722eb5ac63d296", swapProxy: SWAP_PROXY, swapProxyCodehash: SWAP_PROXY_CODEHASH, permit2: PERMIT2, permit2Codehash: "0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca", weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"}, // Robinhood Chain
  5042: {poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951", quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94", stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b", positionManager: "0x6049c9a0e26405C0985f9E3685C87d0aE917f82B", universalRouter: "0x8702463e73f74d0b6765aBceb314Ef07aCb92650", routerBuild: "2.1.2", routerCodehash: "0x2e80a35dc8a1da121611acc5c31be03c2e63669135461e63947901ecf8a1654d", swapProxy: SWAP_PROXY, swapProxyCodehash: SWAP_PROXY_CODEHASH, permit2: PERMIT2, permit2Codehash: "0x05a793d6bdba8b8715c8f4cef0725ec3a961f567d33ebb2d360f541f19f70c8f", weth: null, nativeWrap: false}, // Arc (native coin = USDC)
  8453: {poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b", quoter: "0xE1A6C5803e3c44368b171BD680c7D32dfc92CA47", stateView: "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71", positionManager: "0x7C5f5A4bBd8fD63184577525326123B519429bDc", universalRouter: "0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40", routerBuild: "2.1.2", routerCodehash: "0x816c75fe7f6ccf8fe8b14825091e8dff301fe7ffd4b962f89b2981a747facc08", swapProxy: SWAP_PROXY, swapProxyCodehash: SWAP_PROXY_CODEHASH, permit2: PERMIT2, permit2Codehash: "0xa67739abc3ede9dbdc0491636c67d6a14ac07fab9030c3f509b1eb7b11dff8ed", weth: "0x4200000000000000000000000000000000000006"}, // Base
  42161: {poolManager: "0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32", quoter: "0x8928074CA1b241D8Ec02815881c1Af11E8bC5219", stateView: "0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990", positionManager: "0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869", universalRouter: "0x2d01411773c8C24805306E89A41F7855C3c4Fe65", routerBuild: "2.1.2", routerCodehash: "0x51536ca9d25ebbc535351834b75115ba1843fb402c003d65ead6c760be6cc1c0", swapProxy: SWAP_PROXY, swapProxyCodehash: SWAP_PROXY_CODEHASH, permit2: PERMIT2, permit2Codehash: "0x9e51dcb64cf56fc09a82cb41edbc17c6a2250f18dbd1b91e884c0aca02acd57c", weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"}, // Arbitrum
  42220: {poolManager: "0x288dc841A52FCA2707c6947B3A777c5E56cd87BC", quoter: "0x28566da1093609182dFf2cB2A91CFD72e61d66cd", stateView: "0xbc21f8720BABf4b20d195eE5C6e99c52b76F2bfb", positionManager: "0xf7965f3981e4D5BC383BfBCb61501763e9068CA9", universalRouter: "0xe2023F3FA515cF070e07fD9d51c1d236e07843f4", routerBuild: "2.1.2", routerCodehash: "0x5cb0475e1a803977b889fa491c42623c087ca74b2fc6c322d5899047d01408ce", swapProxy: SWAP_PROXY, swapProxyCodehash: SWAP_PROXY_CODEHASH, permit2: PERMIT2, permit2Codehash: "0x556c591dce0fb9bc236493e7e3e1add37e6bc81fdbfa621ac79667597de7eb91", weth: "0x471EcE3750Da237f93B8E339c536989b8978a438", nativeWrap: false}, // Celo (CELO ERC-20 as the hop token)
  43114: {poolManager: "0x06380C0e0912312B5150364B9DC4542BA0DbBc85", quoter: "0xf27e532878B622d6b916F524E8711880107D4eF0", stateView: "0xc3c9e198C735a4b97e3e683f391cCBDD60B69286", positionManager: "0xB74b1F14d2754AcfcbBe1a221023a5cf50Ab8ACD", universalRouter: "0x661E93cca42AfacB172121EF892830cA3b70F08d", routerBuild: "2.1.2", routerCodehash: "0x39821d3bb1dd8bd39de51a4f9ebd6ca19e41085645765cf4576405ee31c7dd83", swapProxy: SWAP_PROXY, swapProxyCodehash: SWAP_PROXY_CODEHASH, permit2: PERMIT2, permit2Codehash: "0x081beff14e75c5a5c1e60740445f58d54ba0fef228148a11d3e4287dc3551cbb", weth: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7"}, // Avalanche
  57073: {poolManager: "0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32", quoter: "0x8928074CA1b241D8Ec02815881c1Af11E8bC5219", stateView: "0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990", positionManager: "0x1b35d13a2E2528f192637F14B05f0Dc0e7dEB566", universalRouter: "0x661E93cca42AfacB172121EF892830cA3b70F08d", routerBuild: "2.1.2", routerCodehash: "0x9a9304f3546eefaca98621c3181c339f8c8aaa9f8a891e31dcd5170479ad31dc", swapProxy: SWAP_PROXY, swapProxyCodehash: SWAP_PROXY_CODEHASH, permit2: PERMIT2, permit2Codehash: "0xfc5afc02cb5a67998e014fe03df3a318998600509323d4164fa54f0a3b517077", weth: "0x4200000000000000000000000000000000000006"}, // Ink
  59144: {poolManager: "0x248083Fb965359d82b06C1F5322480Dcfc1AD857", quoter: "0x2C125569C0BeE20A66E33E5491C552B37EBD9934", stateView: "0xE861de206E460A8b936b05ad3816520B58ccDf9b", positionManager: "0xdDCAD5775B2816a87495f207731b3571D7EE3c76", universalRouter: "0xDc264714F68d84CF29BC605589405E78bDBE7C9f", routerBuild: "2.1.2", routerCodehash: "0xc7d63a23185cfb34d48108b9a74444efd5ba64b552f03dad42f86054dc1a4d27", swapProxy: SWAP_PROXY, swapProxyCodehash: SWAP_PROXY_CODEHASH, permit2: PERMIT2, permit2Codehash: "0x939f3d8fd3d2ffc9dd506aae79fb3827c60a629d41f9a7f6b85e26275e0ec649", weth: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f"}, // Linea
  99901: {poolManager: "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1", quoter: "0x379F556c5a748BD7Cc9baF0F7A344094Ac1814f5", stateView: "0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE", positionManager: "0x1d1C51b9d07fD27d36412A2b66CC23D19Eb3E518", universalRouter: "0xA13f7611115752DEB2B13813BDDE16A5073e4b45", routerBuild: "2.1.2", routerCodehash: "0x1a7af429c3883cbf53ec7e54fad35a99232faffe04505efb971a799a993ca6a8", swapProxy: SWAP_PROXY, swapProxyCodehash: SWAP_PROXY_CODEHASH, permit2: PERMIT2, permit2Codehash: "0xecc8810a534829aab9326a3f868a21ed05f1c62b57dcc82429c8a78b3a27cfdc", weth: "0xbA876237B0F021A6c6D852d6c26E107997cC5E81"}, // Elysium
});

/** The pinned deployment for a chain id, own keys only (never a prototype property). */
export function uniswapV4DeploymentOf(chainId: number, deployments: Readonly<Record<number, UniswapV4Deployment>> = UNISWAP_V4): UniswapV4Deployment | undefined {
  return Number.isSafeInteger(chainId) && Object.prototype.hasOwnProperty.call(deployments, chainId) ? deployments[chainId] : undefined;
}

// ── Universal Router commands (Commands.sol at tag 2.1.2) ────────────────────────────────────────────────────────

/** Universal Router command bytes. `0x10` is `V4_SWAP` in 2.x only (`SEAPORT_V1_5` in 1.x: never target a 1.x router).
 *  This module writes `V4_SWAP` and nothing else; the rest are listed so a check can name what it refuses. */
export const UR_COMMANDS = Object.freeze({
  V3_SWAP_EXACT_IN: 0x00,
  V3_SWAP_EXACT_OUT: 0x01,
  PERMIT2_TRANSFER_FROM: 0x02,
  PERMIT2_PERMIT_BATCH: 0x03,
  SWEEP: 0x04,
  TRANSFER: 0x05,
  PAY_PORTION: 0x06,
  PAY_PORTION_FULL_PRECISION: 0x07,
  V2_SWAP_EXACT_IN: 0x08,
  V2_SWAP_EXACT_OUT: 0x09,
  PERMIT2_PERMIT: 0x0a,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  PERMIT2_TRANSFER_FROM_BATCH: 0x0d,
  BALANCE_CHECK_ERC20: 0x0e,
  V4_SWAP: 0x10,
  V3_POSITION_MANAGER_PERMIT: 0x11,
  V3_POSITION_MANAGER_CALL: 0x12,
  V4_INITIALIZE_POOL: 0x13,
  V4_POSITION_MANAGER_CALL: 0x14,
  EXECUTE_SUB_PLAN: 0x21,
  ACROSS_V4_DEPOSIT_V3: 0x40,
} as const);
/** Command bit 7: the router swallows that command's revert. Never set by this module, always refused. */
export const UR_FLAG_ALLOW_REVERT = 0x80;
/** Command bit 6: the 2.1.1+ third-party range (`0x40 ACROSS_V4_DEPOSIT_V3`). Always refused. */
export const UR_FLAG_THIRD_PARTY = 0x40;

// ── V4Router actions (v4-periphery Actions.sol at 545a5d2, the UR 2.1.2 pin) ─────────────────────────────────────

/** V4Router action bytes inside a `V4_SWAP` input. The UR's V4Router handles only 0x06–0x09, 0x0b, 0x0c, 0x0e, 0x0f
 *  and 0x10 (the rest revert `UnsupportedAction`); this module writes `[0x06 | 0x07, 0x0b, 0x0e]` only. */
export const V4_ACTIONS = Object.freeze({
  INCREASE_LIQUIDITY: 0x00,
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
  INCREASE_LIQUIDITY_FROM_DELTAS: 0x04,
  MINT_POSITION_FROM_DELTAS: 0x05,
  SWAP_EXACT_IN_SINGLE: 0x06,
  SWAP_EXACT_IN: 0x07,
  SWAP_EXACT_OUT_SINGLE: 0x08,
  SWAP_EXACT_OUT: 0x09,
  DONATE: 0x0a,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  SETTLE_PAIR: 0x0d,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
  TAKE_PORTION: 0x10,
  TAKE_PAIR: 0x11,
  CLOSE_CURRENCY: 0x12,
  CLEAR_OR_TAKE: 0x13,
  SWEEP: 0x14,
  WRAP: 0x15,
  UNWRAP: 0x16,
  MINT_6909: 0x17,
  BURN_6909: 0x18,
} as const);

/** ActionConstants.sol: `amount` 0 = OPEN_DELTA (use the open delta), `1 << 255` = CONTRACT_BALANCE (the router's whole
 *  balance), recipient `0x…01` = MSG_SENDER, `0x…02` = ADDRESS_THIS. This module writes none of them. */
export const V4_ACTION_CONSTANTS = Object.freeze({
  OPEN_DELTA: 0n,
  CONTRACT_BALANCE: 1n << 255n,
  MSG_SENDER: "0x0000000000000000000000000000000000000001",
  ADDRESS_THIS: "0x0000000000000000000000000000000000000002",
} as const);
/** The native coin as a v4 currency (`address(0)`, always `currency0`). */
export const V4_NATIVE = "0x0000000000000000000000000000000000000000" as const;

// ── Entry points and selectors (`viem toFunctionSelector`, checked in tests) ─────────────────────────────────────

/** `UniversalRouter.execute(bytes commands, bytes[] inputs, uint256 deadline)` — the only router entry point this module
 *  writes or accepts. */
export const UR_EXECUTE_SELECTOR = "0x3593564c" as const;
/** `execute(bytes, bytes[])` (no deadline) and `executeSigned(…)`: public on the router, refused here. */
export const UR_EXECUTE_NO_DEADLINE_SELECTOR = "0x24856bc3" as const;
export const UR_EXECUTE_SIGNED_SELECTOR = "0x44684dc3" as const;
/** `SwapProxy.execute(address router, address token, uint256 amount, bytes commands, bytes[] inputs, uint256 deadline)`. */
export const SWAP_PROXY_EXECUTE_SELECTOR = "0x2894adf9" as const;
/** The Universal Router entry points this module writes (activity recognition: a pinned router's `execute` with a
 *  deadline whose commands are `0x10`). */
export const UNISWAP_UR_SELECTORS: ReadonlySet<string> = new Set([UR_EXECUTE_SELECTOR]);
/** The SwapProxy entry point this module writes (activity: only when its `router` argument is the pinned router). */
export const UNISWAP_SWAP_PROXY_SELECTORS: ReadonlySet<string> = new Set([SWAP_PROXY_EXECUTE_SELECTOR]);

// ── Strict 2.1.x ABIs ────────────────────────────────────────────────────────────────────────────────────────────

/** The router entry point (one overload only, so a decode can never pick the no-deadline one) and the linkage getter. */
export const UR_ABI = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
  "function poolManager() view returns (address)",
]);
/** SwapProxy (`SwapProxy.sol:17-34`): non-payable; `safeTransferFrom(msg.sender, router, amount)` then
 *  `router.execute(commands, inputs, deadline)`. */
export const SWAP_PROXY_ABI = parseAbi([
  "function execute(address router, address token, uint256 amount, bytes commands, bytes[] inputs, uint256 deadline)",
]);
/** `poolManager()` of the V4Quoter and the StateView (deployment linkage). */
export const V4_LINKAGE_ABI = parseAbi(["function poolManager() view returns (address)"]);

/** `V4_SWAP` input: `abi.encode(bytes actions, bytes[] params)` — the standard encoding is exactly the strict form
 *  `CalldataDecoder.decodeActionsRouterParams` requires (anything else reverts `SliceOutOfBounds`). */
export const V4_SWAP_INPUT_ABI = parseAbiParameters("bytes actions, bytes[] params");

/**
 * `SWAP_EXACT_IN_SINGLE` params, **UR 2.1.x layout** (`IV4Router.ExactInputSingleParams` with `uint256 minHopPriceX36`).
 * UR 2.0 has no `minHopPriceX36` word, and the two layouts are not compatible: a 2.0 single-hop with a native
 * `currency0` executes on 2.1.2 with shifted words, and a 2.1.x multi-hop sent to 2.0 swapped `amountIn := 640`.
 * Encoded as one tuple, so the data starts with the 0x20 offset word.
 */
export const V4_EXACT_IN_SINGLE_ABI = parseAbiParameters(
  "((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)",
);
/** `SWAP_EXACT_IN` params, UR 2.1.x layout (`ExactInputParams` with `uint256[] minHopPriceX36` before the amounts). */
export const V4_EXACT_IN_ABI = parseAbiParameters(
  "(address currencyIn, (address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)[] path, uint256[] minHopPriceX36, uint128 amountIn, uint128 amountOutMinimum)",
);
/** `SETTLE(currency, amount, payerIsUser)`: amount exact (never OPEN_DELTA or CONTRACT_BALANCE); a native currency is
 *  paid from the router's own `msg.value` (the payer flag is ignored for it). */
export const V4_SETTLE_ABI = parseAbiParameters("address currency, uint256 amount, bool payerIsUser");
/** `TAKE(currency, recipient, amount)`: amount 0 = the whole open credit; recipient always the explicit payout address. */
export const V4_TAKE_ABI = parseAbiParameters("address currency, address recipient, uint256 amount");

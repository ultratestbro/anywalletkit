/**
 * Uniswap v3 deployments this module trusts. Every entry was checked on-chain
 * (2026-10-12): SwapRouter02.factory() and QuoterV2.factory() both return
 * `factory`, and both report `weth` as WETH9. The provider re-checks the same
 * facts once per chain at runtime before quoting (see `verifyDeployment`).
 */
export interface UniswapDeployment {
  factory: `0x${string}`;
  quoter: `0x${string}`;
  router: `0x${string}`;
  /** The chain's wrapped native token (WETH, WBNB, WPOL, WAVAX) — on a chain
   *  without one (Celo), the hop token used for two-hop routes instead. */
  weth: `0x${string}`;
  /** false: the router has no WETH9 (reports 0x0) — no native in/out, the coin is an ERC-20 there. */
  nativeWrap?: false;
  /** false: a newer QuoterV2 build without WETH9() — only its factory is checked. */
  quoterWeth?: false;
}

export const UNISWAP_V3: Readonly<Record<number, UniswapDeployment>> = Object.freeze({
  1: {factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984", quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"},
  10: {factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984", quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", weth: "0x4200000000000000000000000000000000000006"},
  56: {factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7", quoter: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077", router: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2", weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"},
  137: {factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984", quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", weth: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"},
  8453: {factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", router: "0x2626664c2603336E57B271c5C0b26F421741e481", weth: "0x4200000000000000000000000000000000000006"},
  42161: {factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984", quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"},
  // zkSync Era and Celo: addresses from cp0x pi-uniswap-interface, verified on-chain 2026-10-12.
  324: {factory: "0x8FdA5a7a8dCA67BBcDd10F02Fa0649A937215422", quoter: "0x8Cb537fc92E26d8EBBb760E632c95484b6Ea3e28", router: "0x99c56385daBCE3E81d8499d0b8d0257aBC07E8A3", weth: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91"},
  42220: {factory: "0xAfE208a311B21f13EF87E33A90049fC17A7acDEc", quoter: "0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8", router: "0x5615CDAb10dc425a742d643d949a7F474C01abc4", weth: "0x471EcE3750Da237f93B8E339c536989b8978a438", nativeWrap: false},
  // Unichain, Monad, Linea: Uniswap's sdk-core CHAIN_TO_ADDRESSES_MAP, verified on-chain 2026-10-13
  // (router + quoter report the factory; these quoters have no WETH9()).
  130: {factory: "0x1F98400000000000000000000000000000000003", quoter: "0x565AC8C7863D9bb16d07E809ff49Fe5cD467634C", router: "0x73855d06DE49d0fe4A9c42636Ba96c62da12FF9C", weth: "0x4200000000000000000000000000000000000006", quoterWeth: false},
  143: {factory: "0x204FAca1764B154221e35c0d20aBb3c525710498", quoter: "0x2d01411773c8C24805306e89a41f7855c3C4fE65", router: "0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900", weth: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", quoterWeth: false},
  59144: {factory: "0x31FAfd4889FA1269F7a13A66eE0fB458f27D72A9", quoter: "0x58EaD433eA99708604c4dD7C9b7E80c70976E202", router: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", weth: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f", quoterWeth: false},
  // World Chain, Ink, X Layer: Uniswap's sdk-core CHAIN_TO_ADDRESSES_MAP, verified on-chain 2026-10-13
  // (router + quoter report the factory; X Layer's quoter has no WETH9(), its router wraps WOKB).
  480: {factory: "0x7a5028BDa40e7B173C278C5342087826455ea25a", quoter: "0x10158D43e6cc414deE1Bd1eB0EfC6a5cBCfF244c", router: "0x091AD9e2e6e5eD44c1c66dB50e49A601F9f36cF6", weth: "0x4200000000000000000000000000000000000006"},
  57073: {factory: "0x640887A9ba3A9C53Ed27D0F7e8246A4F933f3424", quoter: "0x96b572D2d880cf2Fa2563651BD23ADE6f5516652", router: "0x177778F19E89dD1012BdBe603F144088A95C4B53", weth: "0x4200000000000000000000000000000000000006"},
  196: {factory: "0x4B2ab38DBF28D31D467aA8993f6c2585981D6804", quoter: "0x976183AC3d09840D243A88c0268BADb3B3e3259f", router: "0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA", weth: "0xe538905cf8410324e03A5A23C1c177a474D59b2b", quoterWeth: false},
  // Robinhood Chain: addresses from cp0x pi-uniswap-interface (constants/addresses.ts), verified on-chain 2026-10-12.
  4663: {factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA", quoter: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7", router: "0xCaf681a66D020601342297493863E78C959E5cb2", weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"},
  43114: {factory: "0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD", quoter: "0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F", router: "0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE", weth: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7"},
});

/** Pool fee tiers probed for every hop (0.01%, 0.05%, 0.3%, 1%). */
export const FEE_TIERS = [100, 500, 3000, 10000] as const;
/** Two-hop routes go through these (when the catalog knows them on the chain). */
export const HOP_SYMBOLS = ["WETH", "USDC", "USDT"] as const;
/** SwapRouter02 recipient sentinel: "keep the output in the router" (then unwrapWETH9). */
export const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";

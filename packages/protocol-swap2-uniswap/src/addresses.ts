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
  /** The chain's wrapped native token (WETH, WBNB, WPOL, WAVAX). */
  weth: `0x${string}`;
}

export const UNISWAP_V3: Readonly<Record<number, UniswapDeployment>> = Object.freeze({
  1: {factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984", quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"},
  10: {factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984", quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", weth: "0x4200000000000000000000000000000000000006"},
  56: {factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7", quoter: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077", router: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2", weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"},
  137: {factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984", quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", weth: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"},
  8453: {factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", router: "0x2626664c2603336E57B271c5C0b26F421741e481", weth: "0x4200000000000000000000000000000000000006"},
  42161: {factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984", quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"},
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

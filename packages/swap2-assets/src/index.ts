/**
 * Curated cross-chain asset catalog (native + major stables per chain), NOT a
 * general token list: every entry has been routed through NEAR Intents in
 * production.
 *
 * Shared by server providers (assetId resolution) and client pickers
 * (chain/token lists, decimals) — keep it dependency-free.
 */

export interface CcAsset {
  symbol: string;
  /** 1Click asset id (nep141/nep245). */
  assetId: string;
  decimals: number;
  /** On-chain token id (EVM/SPL/TRC contract, TON jetton master). REQUIRED for
   *  every non-native asset — null/absent means native, and the off-ramp round
   *  trip relies on that invariant. */
  contract?: string | null;
  /** Icon URL (CoinMarketCap static CDN). */
  icon?: string;
}

/** CoinMarketCap static icon. 128px by default: token marks render at
 *  26–36pt on 3x screens (78–108px), where the 64px file blurs; 200 exists
 *  for hero sizes. */
export function cmcIcon(id: number, size: 64 | 128 | 200 = 128): string {
  return `https://s2.coinmarketcap.com/static/img/coins/${size}x${size}/${id}.png`;
}

/** Crisp chain logo (Trust Wallet assets, 256px) — the DeFiLlama thumbs are
 *  ~48px and blur at retina. `slug` is our chain key; map to TW's folder. */
export function chainIcon(slug: string): string {
  const TW: Record<string, string> = {binance: "smartchain"};
  const folder = TW[slug] ?? slug;
  return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${folder}/info/logo.png`;
}

export interface CcChain {
  /** 1Click chain key (their SourceChain naming). */
  key: string;
  /** CAIP-2 id used across our router/config/db. */
  caip2: string;
  label: string;
  /** Chain icon URL (DeFiLlama). */
  icon?: string;
  /** Deposits to this chain's address REQUIRE the memo when one is returned. */
  memo?: boolean;
  /** Parked: kept in the catalog (routing/attribution still resolve it) but
   *  hidden from the deposit and off-ramp pickers. */
  hidden?: boolean;
  /** No inbound route (not in the 1Click registry, and THOR sources are
   *  EVM-only) — off-ramp destination only, hidden from deposit pickers. */
  offrampOnly?: boolean;
  assets: CcAsset[];
}

export const CC_SOURCE_CHAINS: CcChain[] = [
  {
    // Ethereum is both the vault chain AND — for the step-2 off-ramp — the
    // SOURCE the user's own funds leave from. The
    // deposit UI hides it (Ethereum deposits use the direct tab, CC_OTHER_CHAINS);
    // the off-ramp uses it as the fixed source and CC_OTHER_CHAINS as the
    // destinations. 1Click asset ids follow the omft pattern (native + eth-<addr>).
    key: "ethereum",
    caip2: "eip155:1",
    icon: chainIcon("ethereum"),
    label: "Ethereum",
    assets: [
      {symbol: "ETH", assetId: "nep141:eth.omft.near", decimals: 18, icon: cmcIcon(1027)},
      {
        symbol: "USDC",
        assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
        contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        decimals: 6,
        icon: cmcIcon(3408),
      },
      {
        symbol: "USDT",
        assetId: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",
        contract: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        decimals: 6,
        icon: cmcIcon(825),
      },
      {
        // Like stETH below: not in the 1Click registry (omft-pattern assetId
        // in case they list it) — EVM venues quote it.
        symbol: "wstETH",
        assetId: "nep141:eth-0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0.omft.near",
        contract: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
        decimals: 18,
        icon: cmcIcon(12409),
      },
      {
        // NOT in the 1Click registry (assetId follows their omft pattern in
        // case they list it) — today only the EVM venues (LI.FI/0x/Velora)
        // quote it, and the router lets 1Click lose that auction gracefully.
        symbol: "stETH",
        assetId: "nep141:eth-0xae7ab96520de3a18e5e111b5eaab095312d7fe84.omft.near",
        contract: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
        decimals: 18,
        icon: cmcIcon(8085),
      },
      {
        // SSV Network token — the Earn tab's "Get SSV" pre-step for SSV
        // staking. Same story as stETH: not in the 1Click registry (omft-pattern
        // assetId in case they list it), quoted by the EVM venues (LI.FI verified
        // live 2026-09-03: 0.1 ETH → 76 SSV).
        symbol: "SSV",
        assetId: "nep141:eth-0x9d65ff81a3c488d585bbfb0bfe3c7707c7917f54.omft.near",
        contract: "0x9d65ff81a3c488d585bbfb0bfe3c7707c7917f54",
        decimals: 18,
        icon: cmcIcon(12999),
      },
      // 2026-10-09: popular majors (user-approved list) — contracts/decimals from LI.FI's token list.
      {
        symbol: "WBTC",
        assetId: "nep141:eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near",
        contract: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
        decimals: 8,
        icon: cmcIcon(3717),
      },
      {
        symbol: "cbBTC",
        assetId: "nep141:eth-0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf.omft.near",
        contract: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
        decimals: 8,
        icon: cmcIcon(32994),
      },
      {
        symbol: "DAI",
        assetId: "nep141:eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near",
        contract: "0x6b175474e89094c44da98b954eedeac495271d0f",
        decimals: 18,
        icon: cmcIcon(4943),
      },
      {
        symbol: "LINK",
        assetId: "nep141:eth-0x514910771af9ca656af840dff83e8264ecf986ca.omft.near",
        contract: "0x514910771af9ca656af840dff83e8264ecf986ca",
        decimals: 18,
        icon: cmcIcon(1975),
      },
      {
        symbol: "UNI",
        assetId: "nep141:eth-0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.omft.near",
        contract: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
        decimals: 18,
        icon: cmcIcon(7083),
      },
      {
        symbol: "AAVE",
        assetId: "nep141:eth-0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9.omft.near",
        contract: "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9",
        decimals: 18,
        icon: cmcIcon(7278),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "ARB",
        assetId: "",
        contract: "0xb50721bcf8d664c30412cfbc6cf7a15145234ad1",
        decimals: 18,
        icon: cmcIcon(11841),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "USDe",
        assetId: "",
        contract: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
        decimals: 18,
        icon: cmcIcon(29470),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "PYUSD",
        assetId: "",
        contract: "0x6c3ea9036406852006290770bedfcaba0e23a0e8",
        decimals: 6,
        icon: cmcIcon(27772),
      },
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "BNB", assetId: "", contract: "0xb8c77482e45f1f44de1745f52c74426c631bdd52", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/825/large/bnb-icon2_2x.png?1696501970"},
      {symbol: "USDS", assetId: "", contract: "0xdc035d45d973e3ec169d2276ddab16f1e407384f", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/39926/large/usds.webp?1726666683"},
      {symbol: "wBETH", assetId: "", contract: "0xa2e3356610840701bdf5611a53974510ae27e2e1", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/30061/large/wbeth-icon.png?1696528983"},
      {symbol: "weETH", assetId: "", contract: "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33033/large/weETH.png?1701438396"},
    ],
  },
  {
    key: "bitcoin",
    caip2: "bitcoin:mainnet",
    icon: chainIcon("bitcoin"),
    label: "Bitcoin",
    assets: [{symbol: "BTC", assetId: "nep141:btc.omft.near", decimals: 8, icon: cmcIcon(1)}],
  },
  {
    // NEAR Intents only (LI.FI/THORChain don't route Zcash). Address-only
    // deposits (no wallet adapter), like Bitcoin. PARKED (2026-07): routes are
    // live (verified via 1Click) but no ZEC wallet can CONNECT (no Reown
    // namespace, no wallet-side WC) — hidden from the pickers until the UX
    // story is decided.
    key: "zec",
    caip2: "zcash:mainnet",
    icon: chainIcon("zcash"),
    label: "Zcash",
    hidden: true,
    assets: [{symbol: "ZEC", assetId: "nep141:zec.omft.near", decimals: 8, icon: cmcIcon(1437)}],
  },
  {
    key: "ton",
    caip2: "ton:-239",
    icon: chainIcon("ton"),
    label: "TON",
    memo: true,
    assets: [
      // Toncoin → Gram (GRAM) since 2026-06-15; the chain keeps the TON name.
      {symbol: "GRAM", assetId: "nep245:v2_1.omni.hot.tg:1117_", decimals: 9, icon: cmcIcon(11419)},
      {
        symbol: "USDT",
        assetId: "nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR",
        // Tether's jetton master. Non-native assets MUST carry `contract`: the
        // off-ramp round-trips (chain, contract) through ccAssetByToken, and a
        // missing contract made TON-USDT quotes resolve to NATIVE TON (9 dec
        // shown as USDT/6 — the "7 USDT → 4,304 USDT" bug).
        contract: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs",
        decimals: 6,
        icon: cmcIcon(825),
      },
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "USDe", assetId: "", contract: "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f", decimals: 6},
      {symbol: "sUSDe", assetId: "", contract: "EQDQ5UUyPHrLcQJlPAczd_fjxn8SLrlNQwolBznxCdSlfQwr", decimals: 6},
      {symbol: "FDUSD", assetId: "", contract: "EQD0Evpk4timFOHmy4Sv3l_KEUXlM-dN1_KhroTCfB2wkO89", decimals: 6},
      {symbol: "XAUt0", assetId: "", contract: "EQA1R_LuQCLHlMgOo1S4G7Y7W1cd0FrAkbA10Zq7rddKxi9k", decimals: 6},
      {symbol: "GOMINING", assetId: "", contract: "EQD0laik0FgHV8aNfRhebi8GDG2rpDyKGXem0MBfya_Ew1-8", decimals: 18},
      {symbol: "TSLAx", assetId: "", contract: "EQB4IwqWZPUczntdry8vSN2tsJKt-9F7iIb7gEFREYYOB563", decimals: 8},
      {symbol: "NVDAx", assetId: "", contract: "EQCva-Of7acQdU_piADdlcbzsFtA-xJwZoctz8ZOXBdBoaB8", decimals: 8},
    ],
  },
  {
    key: "solana",
    caip2: "solana:mainnet",
    icon: chainIcon("solana"),
    label: "Solana",
    assets: [
      {symbol: "SOL", assetId: "nep141:sol.omft.near", decimals: 9, icon: cmcIcon(5426)},
      {
        symbol: "USDC",
        assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
        contract: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        decimals: 6,
        icon: cmcIcon(3408),
      },
      {
        symbol: "USDT",
        assetId: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near",
        contract: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        decimals: 6,
        icon: cmcIcon(825),
      },
      // 2026-10-09: popular majors (user-approved list) — contracts/decimals from LI.FI's token list.
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "cbBTC",
        assetId: "",
        contract: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
        decimals: 8,
        icon: cmcIcon(32994),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "USDe",
        assetId: "",
        contract: "DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT",
        decimals: 9,
        icon: cmcIcon(29470),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "PYUSD",
        assetId: "",
        contract: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
        decimals: 6,
        icon: cmcIcon(27772),
      },
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "USDS", assetId: "", contract: "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA", decimals: 6, icon: "https://coin-images.coingecko.com/coins/images/39926/large/usds.webp?1726666683"},
      {symbol: "LINK", assetId: "", contract: "LinkhB3afbBKb2EQQu7s7umdZceV3wcvAUJhQAfQ23L", decimals: 9, icon: "https://coin-images.coingecko.com/coins/images/877/large/Chainlink_Logo_500.png?1760023405"},
      {symbol: "WBTC", assetId: "", contract: "5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ", decimals: 8, icon: "https://coin-images.coingecko.com/coins/images/7598/large/WBTCLOGO.png?1764496367"},
      {symbol: "USD1", assetId: "nep141:sol-0x936420c6ae310eb29511d139991654f922456fbe.omdep.near", contract: "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", decimals: 6, icon: "https://coin-images.coingecko.com/coins/images/54977/large/USD1_1000x1000_transparent.png?1749297002"},
      {symbol: "USDG", assetId: "", contract: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", decimals: 6, icon: "https://coin-images.coingecko.com/coins/images/51281/large/GDN_USDG_Token_200x200.png?1730484111"},
      {symbol: "ENA", assetId: "", contract: "72QvBVwpxqmheEPfaCwWSWqEFsUy3rhWt6JhQBMNTwD1", decimals: 9, icon: "https://coin-images.coingecko.com/coins/images/36530/large/ethena.png?1711701436"},
      {symbol: "AAVE", assetId: "", contract: "AavE1kKKnesPw4MuRJmJ9jZs9QzEE8CPxQ3ViczUDfc1", decimals: 8, icon: "https://coin-images.coingecko.com/coins/images/12645/large/aave-token-round.png?1720472354"},
      {symbol: "USDY", assetId: "", contract: "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6", decimals: 6, icon: "https://coin-images.coingecko.com/coins/images/31700/large/usdy_%281%29.png?1696530524"},
    ],
  },
  {
    key: "tron",
    caip2: "tron:728126428",
    icon: chainIcon("tron"),
    label: "Tron",
    assets: [
      {symbol: "TRX", assetId: "nep141:tron.omft.near", decimals: 6, icon: cmcIcon(1958)},
      {
        symbol: "USDT",
        assetId: "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near",
        contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        decimals: 6,
        icon: cmcIcon(825),
      },
    ],
  },
  {
    key: "near",
    caip2: "near:mainnet",
    icon: chainIcon("near"),
    label: "NEAR",
    assets: [
      // 1Click keys native NEAR by its wrapped id; deposits/withdrawals move NEAR itself.
      {symbol: "NEAR", assetId: "nep141:wrap.near", decimals: 24, icon: cmcIcon(6535)},
      {
        symbol: "USDC",
        assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        contract: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        decimals: 6,
        icon: cmcIcon(3408),
      },
      {symbol: "USDT", assetId: "nep141:usdt.tether-token.near", contract: "usdt.tether-token.near", decimals: 6, icon: cmcIcon(825)},
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "AURORA", assetId: "nep141:aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near", contract: "aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/20582/large/aurora.jpeg?1696519989"},
      {symbol: "ETH", assetId: "nep141:eth.bridge.near", contract: "eth.bridge.near", decimals: 18},
      {symbol: "wBTC", assetId: "nep141:2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near", contract: "2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near", decimals: 8},
    ],
  },
  {
    key: "base",
    caip2: "eip155:8453",
    icon: chainIcon("base"),
    label: "Base",
    assets: [
      {symbol: "ETH", assetId: "nep141:base.omft.near", decimals: 18, icon: cmcIcon(1027)},
      {
        symbol: "USDC",
        assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
        contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        decimals: 6,
        icon: cmcIcon(3408),
      },
      {
        symbol: "USDT",
        assetId: "",
        contract: "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2",
        decimals: 6,
        icon: cmcIcon(825),
      },
      // 2026-10-09: popular majors (user-approved list) — contracts/decimals from LI.FI's token list.
      {
        symbol: "cbBTC",
        assetId: "nep141:base-0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf.omft.near",
        contract: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
        decimals: 8,
        icon: cmcIcon(32994),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "DAI",
        assetId: "",
        contract: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb",
        decimals: 18,
        icon: cmcIcon(4943),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "LINK",
        assetId: "",
        contract: "0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196",
        decimals: 18,
        icon: cmcIcon(1975),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "AAVE",
        assetId: "",
        contract: "0x63706e401c06ac8513145b7687a14804d17f814b",
        decimals: 18,
        icon: cmcIcon(7278),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "USDe",
        assetId: "",
        contract: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34",
        decimals: 18,
        icon: cmcIcon(29470),
      },
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "weETH", assetId: "", contract: "0x04c0599ae5a44757c0af6f9ec3b93da8976c150a", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33033/large/weETH.png?1701438396"},
      {symbol: "ENA", assetId: "", contract: "0x58538e6a46e07434d7e7375bc268d3cb839c0133", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/36530/large/ethena.png?1711701436"},
      {symbol: "MORPHO", assetId: "", contract: "0xbaa5cc21fd487b8fcc2f632f3f4e8d37262a0842", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/29837/large/Morpho-token-icon.png?1726771230"},
      {symbol: "sUSDe", assetId: "", contract: "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33669/large/sUSDe-Symbol-Color.png?1716307680"},
    ],
  },
  {
    key: "arbitrum",
    caip2: "eip155:42161",
    icon: chainIcon("arbitrum"),
    label: "Arbitrum",
    assets: [
      {symbol: "ETH", assetId: "nep141:arb.omft.near", decimals: 18, icon: cmcIcon(1027)},
      {
        symbol: "USDC",
        assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
        contract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
        decimals: 6,
        icon: cmcIcon(3408),
      },
      {
        symbol: "USDT0",
        assetId: "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near",
        contract: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
        decimals: 6,
        icon: cmcIcon(38517),
      },
      // 2026-10-09: popular majors (user-approved list) — contracts/decimals from LI.FI's token list.
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "WBTC",
        assetId: "",
        contract: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f",
        decimals: 8,
        icon: cmcIcon(3717),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "cbBTC",
        assetId: "",
        contract: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
        decimals: 8,
        icon: cmcIcon(32994),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "DAI",
        assetId: "",
        contract: "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1",
        decimals: 18,
        icon: cmcIcon(4943),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "LINK",
        assetId: "",
        contract: "0xf97f4df75117a78c1a5a0dbb814af92458539fb4",
        decimals: 18,
        icon: cmcIcon(1975),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "UNI",
        assetId: "",
        contract: "0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0",
        decimals: 18,
        icon: cmcIcon(7083),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "AAVE",
        assetId: "",
        contract: "0xba5ddd1f9d7f570dc94a51479a000e3bce967196",
        decimals: 18,
        icon: cmcIcon(7278),
      },
      {
        symbol: "ARB",
        assetId: "nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near",
        contract: "0x912ce59144191c1204e64559fe8253a0e49e6548",
        decimals: 18,
        icon: cmcIcon(11841),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "USDe",
        assetId: "",
        contract: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34",
        decimals: 18,
        icon: cmcIcon(29470),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "PYUSD",
        assetId: "",
        contract: "0x46850ad61c2b7d64d08c9c754f45254596696984",
        decimals: 6,
        icon: cmcIcon(27772),
      },
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "USDS", assetId: "", contract: "0x6491c05a82219b8d1479057361ff1654749b876b", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/39926/large/usds.webp?1726666683"},
      {symbol: "sUSDS", assetId: "", contract: "0xddb46999f8891663a8f2828d25298f70416d7610", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/52721/large/sUSDS_Coin.png?1734086971"},
      {symbol: "USDG", assetId: "", contract: "0x004b506865409877c9fa29bfb1eba929984b9bbc", decimals: 6, icon: "https://coin-images.coingecko.com/coins/images/51281/large/GDN_USDG_Token_200x200.png?1730484111"},
      {symbol: "ENA", assetId: "", contract: "0x58538e6a46e07434d7e7375bc268d3cb839c0133", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/36530/large/ethena.png?1711701436"},
      {symbol: "USDY", assetId: "", contract: "0x35e050d3c0ec2d29d269a8ecea763a183bdf9a9d", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/31700/large/usdy_%281%29.png?1696530524"},
    ],
  },
  {
    key: "optimism",
    caip2: "eip155:10",
    icon: chainIcon("optimism"),
    label: "Optimism",
    assets: [
      {symbol: "ETH", assetId: "nep245:v2_1.omni.hot.tg:10_11111111111111111111", decimals: 18, icon: cmcIcon(1027)},
      {
        symbol: "USDT",
        assetId: "nep245:v2_1.omni.hot.tg:10_359RPSJVdTxwTJT9TyGssr2rFoWo",
        contract: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58",
        decimals: 6,
        icon: cmcIcon(825),
      },
      // 2026-10-09: popular majors (user-approved list) — contracts/decimals from LI.FI's token list.
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "WBTC",
        assetId: "",
        contract: "0x0555e30da8f98308edb960aa94c0db47230d2b9c",
        decimals: 8,
        icon: cmcIcon(3717),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "DAI",
        assetId: "",
        contract: "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1",
        decimals: 18,
        icon: cmcIcon(4943),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "LINK",
        assetId: "",
        contract: "0x350a791bfc2c21f9ed5d10980dad2e2638ffa7f6",
        decimals: 18,
        icon: cmcIcon(1975),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "UNI",
        assetId: "",
        contract: "0x6fd9d7ad17242c41f7131d257212c54a0e816691",
        decimals: 18,
        icon: cmcIcon(7083),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "AAVE",
        assetId: "",
        contract: "0x76fb31fb4af56892a25e32cfc43de717950c9278",
        decimals: 18,
        icon: cmcIcon(7278),
      },
      {
        symbol: "OP",
        assetId: "nep245:v2_1.omni.hot.tg:10_vLAiSt9KfUGKpw5cD3vsSyNYBo7",
        contract: "0x4200000000000000000000000000000000000042",
        decimals: 18,
        icon: cmcIcon(11840),
      },
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "USDC", assetId: "nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ", contract: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", decimals: 6, icon: "https://coin-images.coingecko.com/coins/images/6319/large/USDC.png?1769615602"},
      {symbol: "weETH", assetId: "", contract: "0x5a7facb970d094b6c7ff1df0ea68d99e6e73cbff", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33033/large/weETH.png?1701438396"},
      {symbol: "USDT0", assetId: "nep245:v2_1.omni.hot.tg:10_2R1RXDBxCyJTeMEsdXydh7xsHmz", contract: "0x01bff41798a0bcf287b996046ca68b395dbc1071", decimals: 6, icon: "https://coin-images.coingecko.com/coins/images/53705/large/usdt0.jpg?1737086183"},
      {symbol: "ENA", assetId: "", contract: "0x58538e6a46e07434d7e7375bc268d3cb839c0133", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/36530/large/ethena.png?1711701436"},
      {symbol: "WLD", assetId: "", contract: "0xdc6ff44d5d932cbd77b52e5612ba0529dc6226f1", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/31069/large/worldcoin.jpeg?1696529903"},
      {symbol: "sUSDe", assetId: "", contract: "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33669/large/sUSDe-Symbol-Color.png?1716307680"},
    ],
  },
  {
    key: "bsc",
    caip2: "eip155:56",
    icon: chainIcon("binance"),
    label: "BNB Chain",
    assets: [
      {symbol: "BNB", assetId: "nep245:v2_1.omni.hot.tg:56_11111111111111111111", decimals: 18, icon: cmcIcon(1839)},
      {
        symbol: "USDT",
        assetId: "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g",
        contract: "0x55d398326f99059ff775485246999027b3197955",
        decimals: 18,
        icon: cmcIcon(825),
      },
      {
        symbol: "USDC",
        assetId: "nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r", // 1Click token list, verified 2026-10-11
        contract: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
        decimals: 18,
        icon: cmcIcon(3408),
      },
      // 2026-10-09: popular majors (user-approved list) — contracts/decimals from LI.FI's token list.
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "LINK",
        assetId: "",
        contract: "0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd",
        decimals: 18,
        icon: cmcIcon(1975),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "USDe",
        assetId: "",
        contract: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34",
        decimals: 18,
        icon: cmcIcon(29470),
      },
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "wBETH", assetId: "", contract: "0xa2e3356610840701bdf5611a53974510ae27e2e1", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/30061/large/wbeth-icon.png?1696528983"},
      {symbol: "weETH", assetId: "", contract: "0x04c0599ae5a44757c0af6f9ec3b93da8976c150a", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33033/large/weETH.png?1701438396"},
      {symbol: "UNI", assetId: "", contract: "0xbf5140a22578168fd562dccf235e5d43a02ce9b1", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/12504/large/uniswap-logo.png?1720676669"},
      {symbol: "USD1", assetId: "", contract: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/54977/large/USD1_1000x1000_transparent.png?1749297002"},
      {symbol: "AAVE", assetId: "", contract: "0xfb6115445bff7b52feb98650c87f44907e58f802", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/12645/large/aave-token-round.png?1720472354"},
      {symbol: "USDY", assetId: "", contract: "0x608593d17a2decbbc4399e4185be4922f97ed32e", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/31700/large/usdy_%281%29.png?1696530524"},
    ],
  },
  {
    key: "polygon",
    caip2: "eip155:137",
    icon: chainIcon("polygon"),
    label: "Polygon",
    assets: [
      {symbol: "POL", assetId: "nep245:v2_1.omni.hot.tg:137_11111111111111111111", decimals: 18, icon: cmcIcon(28321)},
      {
        symbol: "USDT",
        assetId: "nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr",
        contract: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
        decimals: 6,
        icon: cmcIcon(825),
      },
      {
        symbol: "USDC",
        assetId: "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L", // 1Click token list, verified 2026-10-11
        contract: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
        decimals: 6,
        icon: cmcIcon(3408),
      },
      {
        symbol: "pUSD",
        assetId: "",
        contract: "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb",
        decimals: 6,
      },
      // 2026-10-09: popular majors (user-approved list) — contracts/decimals from LI.FI's token list.
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "WBTC",
        assetId: "",
        contract: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
        decimals: 8,
        icon: cmcIcon(3717),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "DAI",
        assetId: "",
        contract: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
        decimals: 18,
        icon: cmcIcon(4943),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "LINK",
        assetId: "",
        contract: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
        decimals: 18,
        icon: cmcIcon(1975),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "UNI",
        assetId: "",
        contract: "0xb33eaad8d922b1083446dc23f610c2567fb5180f",
        decimals: 18,
        icon: cmcIcon(7083),
      },
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "AAVE",
        assetId: "",
        contract: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
        decimals: 18,
        icon: cmcIcon(7278),
      },
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "PYUSD", assetId: "", contract: "0x99af3eea856556646c98c8b9b2548fe815240750", decimals: 6, icon: "https://coin-images.coingecko.com/coins/images/31212/large/PYUSD_Token_Logo_2x.png?1765987788"},
      {symbol: "rETH", assetId: "", contract: "0x0266f4f08d82372cf0fcbccc0ff74309089c74d1", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/20764/large/reth.png?1696520159"},
      {symbol: "ZRO", assetId: "", contract: "0x6985884c4392d348587b19cb9eaaf157f13271cd", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/28206/large/ftxG9_TJ_400x400.jpeg?1696527208"},
    ],
  },
  {
    key: "gnosis",
    caip2: "eip155:100",
    icon: chainIcon("xdai"),
    label: "Gnosis",
    assets: [
      {symbol: "xDAI", assetId: "nep141:gnosis.omft.near", decimals: 18, icon: cmcIcon(8635)},
      {
        symbol: "USDC",
        assetId: "nep141:gnosis-0x2a22f9c3b484c3629090feed35f17ff8f88f76f0.omft.near",
        contract: "0x2a22f9c3b484c3629090feed35f17ff8f88f76f0",
        decimals: 6,
        icon: cmcIcon(3408),
      },
      {
        symbol: "USDT",
        assetId: "nep141:gnosis-0x4ecaba5870353805a9f068101a40e0f32ed605c6.omft.near",
        contract: "0x4ecaba5870353805a9f068101a40e0f32ed605c6",
        decimals: 6,
        icon: cmcIcon(825),
      },
      // 2026-10-13 — LI.FI only (no 1Click id); verified on-chain.
      {symbol: "GNO", assetId: "", contract: "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb", decimals: 18, icon: cmcIcon(1659)},
      {symbol: "WETH", assetId: "", contract: "0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1", decimals: 18, icon: cmcIcon(2396)},
      {symbol: "WBTC", assetId: "", contract: "0x8e5bBbb09Ed1ebdE8674Cda39A0c169401db4252", decimals: 8, icon: cmcIcon(3717)},
      {symbol: "EURe", assetId: "", contract: "0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430", decimals: 18},
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "LINK", assetId: "", contract: "0xe2e73a1c69ecf83f464efce6a5be353a37ca09b2", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/877/large/Chainlink_Logo_500.png?1760023405"},
      {symbol: "UNI", assetId: "", contract: "0x4537e328bf7e4efa29d05caea260d7fe26af9d74", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/12504/large/uniswap-logo.png?1720676669"},
      {symbol: "GHO", assetId: "", contract: "0xfc421ad3c883bf9e7c4f42de845c4e4405799e73", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/30663/large/gho-token-logo.png?1720517092"},
      {symbol: "crvUSD", assetId: "", contract: "0xabef652195f98a91e490f047a5006b71c85f058d", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/30118/large/crvusd.jpg?1746670973"},
      {symbol: "SAFE", assetId: "nep141:gnosis-0x4d18815d14fe5c3304e87b3fa18318baa5c23820.omft.near", contract: "0x4d18815d14fe5c3304e87b3fa18318baa5c23820", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/27032/large/Artboard_1_copy_8circle-1.png?1696526084"},
      {symbol: "YFI", assetId: "", contract: "0xbf65bfcb5da067446cee6a706ba3fe2fb1a9fdfd", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/11849/large/yearn.jpg?1696511720"},
      {symbol: "COW", assetId: "nep141:gnosis-0x177127622c4a00f3d409b75571e12cb3c8973d3c.omft.near", contract: "0x177127622c4a00f3d409b75571e12cb3c8973d3c", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/24384/large/CoW-token_logo.png?1719524382"},
      {symbol: "TRB", assetId: "", contract: "0xaad66432d27737ecf6ed183160adc5ef36ab99f2", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/9644/large/TRB-New_Logo.png?1737722143"},
    ],
  },
  {
    key: "monad",
    caip2: "eip155:143",
    // Not in the Trust Wallet set — use LI.FI's hosted chain mark.
    icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/monad.svg",
    label: "Monad",
    assets: [
      {
        symbol: "MON",
        assetId: "nep245:v2_1.omni.hot.tg:143_11111111111111111111",
        decimals: 18,
        icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/monad.svg",
      },
      {
        symbol: "USDC",
        assetId: "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
        contract: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
        decimals: 6,
        icon: cmcIcon(3408),
      },
      {
        symbol: "USDT0",
        assetId: "nep245:v2_1.omni.hot.tg:143_4EJiJxSALvGoTZbnc8K7Ft9533et",
        contract: "0xe7cd86e13ac4309349f30b3435a9d337750fc82d",
        decimals: 6,
        icon: cmcIcon(38517),
      },
      // 2026-10-13 — LI.FI / Uniswap only (no 1Click id); verified on-chain.
      {symbol: "WETH", assetId: "", contract: "0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242", decimals: 18, icon: cmcIcon(2396)},
      {symbol: "WBTC", assetId: "", contract: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c", decimals: 8, icon: cmcIcon(3717)},
      {symbol: "AUSD", assetId: "", contract: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", decimals: 6},
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "wstETH", assetId: "", contract: "0x10aeaf63194db8d453d4d85a06e5efe1dd0b5417", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/18834/large/wstETH.png?1696518295"},
      {symbol: "cbBTC", assetId: "", contract: "0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b", decimals: 8, icon: "https://coin-images.coingecko.com/coins/images/40143/large/cbbtc.webp?1726136727"},
      {symbol: "weETH", assetId: "", contract: "0xa3d68b74bf0528fdd07263c60d6488749044914b", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33033/large/weETH.png?1701438396"},
      {symbol: "USD1", assetId: "", contract: "0x111111d2bf19e43c34263401e0cad979ed1cdb61", decimals: 6, icon: "https://coin-images.coingecko.com/coins/images/54977/large/USD1_1000x1000_transparent.png?1749297002"},
      {symbol: "sUSDe", assetId: "", contract: "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33669/large/sUSDe-Symbol-Color.png?1716307680"},
      {symbol: "GHO", assetId: "", contract: "0xfc421ad3c883bf9e7c4f42de845c4e4405799e73", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/30663/large/gho-token-logo.png?1720517092"},
      {symbol: "SolvBTC", assetId: "", contract: "0xae4efbc7736f963982aacb17efa37fcbab924cb3", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/36800/large/solvBTC.png?1719810684"},
    ],
  },
  {
    // LI.FI only — NEAR Intents doesn't route Unichain, so these assets carry
    // no 1Click assetId (empty string; the NEAR provider skips them).
    key: "unichain",
    caip2: "eip155:130",
    icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/unichain.svg",
    label: "Unichain",
    assets: [
      {symbol: "ETH", assetId: "", decimals: 18, icon: cmcIcon(1027)},
      {
        symbol: "USDC",
        assetId: "",
        contract: "0x078d782b760474a361dda0af3839290b0ef57ad6",
        decimals: 6,
        icon: cmcIcon(3408),
      },
      // 2026-10-13 — verified on-chain.
      {symbol: "WBTC", assetId: "", contract: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c", decimals: 8, icon: cmcIcon(3717)},
      {symbol: "DAI", assetId: "", contract: "0x20CAb320A855b39F724131C69424240519573f81", decimals: 18, icon: cmcIcon(4943)},
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "wstETH", assetId: "", contract: "0xc02fe7317d4eb8753a02c35fe019786854a92001", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/18834/large/wstETH.png?1696518295"},
      {symbol: "weETH", assetId: "", contract: "0x7dcc39b4d1c53cb31e1abc0e358b43987fef80f7", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33033/large/weETH.png?1701438396"},
      {symbol: "JUP", assetId: "", contract: "0xbe51a5e8fa434f09663e8fb4cce79d0b2381afad", decimals: 6, icon: "https://coin-images.coingecko.com/coins/images/34188/large/jup.png?1704266489"},
      {symbol: "rETH", assetId: "", contract: "0x94cac393f3444cef63a651ffc18497e7e8bd036a", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/20764/large/reth.png?1696520159"},
      {symbol: "uniBTC", assetId: "", contract: "0xd3c8da379d71a33bfee8875f87ac2748beb1d58d", decimals: 8, icon: "https://coin-images.coingecko.com/coins/images/39599/large/uniBTC_200px.png?1723064455"},
    ],
  },
  {
    // HyperEVM — LI.FI-only (NEAR Intents has hypercore USDC, not HyperEVM),
    // so empty assetId like Monad/Unichain; native HYPE + USDC. Routes verified
    // live (Across / relay). Wallet deposits switch to chain 999 via Reown.
    key: "hyperevm",
    caip2: "eip155:999",
    icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/hyperevm.svg",
    label: "HyperEVM",
    assets: [
      {symbol: "HYPE", assetId: "", decimals: 18, icon: cmcIcon(32196)},
      {
        symbol: "USDC",
        assetId: "",
        contract: "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
        decimals: 6,
        icon: cmcIcon(3408),
      },
      // 2026-10-09: popular majors (user-approved list) — contracts/decimals from LI.FI's token list.
      {
        // Not in the 1Click registry — LI.FI (and THORChain where pooled) quote it.
        symbol: "USDe",
        assetId: "",
        contract: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34",
        decimals: 18,
        icon: cmcIcon(29470),
      },
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "LINK", assetId: "", contract: "0x1ac2ee68b8d038c982c1e1f73f596927dd70de59", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/877/large/Chainlink_Logo_500.png?1760023405"},
      {symbol: "weETH", assetId: "", contract: "0xa3d68b74bf0528fdd07263c60d6488749044914b", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33033/large/weETH.png?1701438396"},
      {symbol: "AAVE0", assetId: "", contract: "0xaa3871e64ca8c09fbdded327b1269224643cb83c", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/102175743/large/aave0.png?1787293474"},
      {symbol: "sUSDe", assetId: "", contract: "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33669/large/sUSDe-Symbol-Color.png?1716307680"},
      {symbol: "kHYPE", assetId: "", contract: "0xfd739d4e423301ce9385c1fb8850539d657c296d", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/67388/large/khype.png?1752632397"},
      {symbol: "SolvBTC", assetId: "", contract: "0xae4efbc7736f963982aacb17efa37fcbab924cb3", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/36800/large/solvBTC.png?1719810684"},
    ],
  },
  {
    // 2026-08 catalog sweep: 1Click added the chain (nep245 hot-bridge ids),
    // LI.FI and Omniston route it too — the best-covered addition.
    key: "avalanche",
    caip2: "eip155:43114",
    icon: chainIcon("avalanchec"),
    label: "Avalanche",
    assets: [
      {symbol: "AVAX", assetId: "nep245:v2_1.omni.hot.tg:43114_11111111111111111111", decimals: 18, icon: cmcIcon(5805)},
      {
        symbol: "USDT",
        assetId: "nep245:v2_1.omni.hot.tg:43114_372BeH7ENZieCaabwkbWkBiTTgXp",
        contract: "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7",
        decimals: 6,
        icon: cmcIcon(825),
      },
      {
        symbol: "USDC",
        assetId: "nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o",
        contract: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
        decimals: 6,
        icon: cmcIcon(3408),
      },
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "LINK.e", assetId: "", contract: "0x5947bb275c521040051d82396192181b413227a3", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/877/large/Chainlink_Logo_500.png?1760023405"},
      {symbol: "weETH", assetId: "", contract: "0xa3d68b74bf0528fdd07263c60d6488749044914b", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33033/large/weETH.png?1701438396"},
      {symbol: "UNI.e", assetId: "", contract: "0x8ebaf22b6f053dffeaf46f4dd9efa95d89ba8580", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/12504/large/uniswap-logo.png?1720676669"},
      {symbol: "ENA", assetId: "", contract: "0x58538e6a46e07434d7e7375bc268d3cb839c0133", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/36530/large/ethena.png?1711701436"},
      {symbol: "AAVE.e", assetId: "", contract: "0x63a72806098bd3d9520cc43356dd78afe5d386d9", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/12645/large/aave-token-round.png?1720472354"},
      {symbol: "sUSDe", assetId: "", contract: "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33669/large/sUSDe-Symbol-Color.png?1716307680"},
      {symbol: "rsETH", assetId: "", contract: "0xc430c78da6e4af49bd115f0329d154bb135f1363", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33800/large/Icon___Dark.png?1702991855"},
      {symbol: "ZRO", assetId: "", contract: "0x6985884c4392d348587b19cb9eaaf157f13271cd", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/28206/large/ftxG9_TJ_400x400.jpeg?1696527208"},
    ],
  },
  {
    // 2026-08 sweep: 1Click (nep245) + LI.FI.
    key: "scroll",
    caip2: "eip155:534352",
    icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/scroll.svg",
    label: "Scroll",
    assets: [
      {symbol: "ETH", assetId: "nep245:v2_1.omni.hot.tg:534352_11111111111111111111", decimals: 18, icon: cmcIcon(1027)},
      {
        symbol: "USDT",
        assetId: "nep245:v2_1.omni.hot.tg:534352_4RG3Q2wFsMQmd45m5m89RjsLfupA",
        contract: "0xf55bec9cafdbe8730f096aa55dad6d22d44099df",
        decimals: 6,
        icon: cmcIcon(825),
      },
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "LINK", assetId: "", contract: "0x548c6944cba02b9d1c0570102c89de64d258d3ac", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/877/large/Chainlink_Logo_500.png?1760023405"},
      {symbol: "weETH", assetId: "", contract: "0x01f0a31698c4d065659b9bdc21b3610292a1c506", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33033/large/weETH.png?1701438396"},
      {symbol: "ENA", assetId: "", contract: "0x58538e6a46e07434d7e7375bc268d3cb839c0133", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/36530/large/ethena.png?1711701436"},
      {symbol: "sUSDe", assetId: "", contract: "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33669/large/sUSDe-Symbol-Color.png?1716307680"},
      {symbol: "ETHFI", assetId: "", contract: "0x056a5fa5da84ceb7f93d36e545c5905607d8bd81", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/35958/large/etherfi.jpeg?1710254562"},
      {symbol: "frxUSD", assetId: "", contract: "0x397f939c3b91a74c321ea7129396492ba9cdce82", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/53963/large/frxUSD.png?1737792154"},
      {symbol: "rswETH", assetId: "", contract: "0x89f17ab70cafb1468d633056161573efefea0713", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/34489/large/rswETH_Icon.png?1706865484"},
    ],
  },
  {
    // 2026-08 sweep: 1Click (omft) + LI.FI.
    key: "berachain",
    caip2: "eip155:80094",
    icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/berachain.svg",
    label: "Berachain",
    assets: [
      {symbol: "BERA", assetId: "nep141:bera.omft.near", decimals: 18, icon: cmcIcon(24647)},
      {
        symbol: "USDT0",
        assetId: "nep141:bera-0x779ded0c9e1022225f8e0630b35a9b54be713736.omft.near",
        contract: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
        decimals: 6,
        icon: cmcIcon(38517),
      },
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "weETH", assetId: "", contract: "0x7dcc39b4d1c53cb31e1abc0e358b43987fef80f7", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33033/large/weETH.png?1701438396"},
      {symbol: "sUSDe", assetId: "", contract: "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33669/large/sUSDe-Symbol-Color.png?1716307680"},
      {symbol: "rsETH", assetId: "", contract: "0x4186bfc76e2e237523cbc30fd220fe055156b41f", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33800/large/Icon___Dark.png?1702991855"},
      {symbol: "LBTC", assetId: "", contract: "0xecac9c5f704e954931349da37f60e39f515c11c1", decimals: 8, icon: "https://coin-images.coingecko.com/coins/images/39969/large/lbtc-token-circle-200.png?1786635984"},
      {symbol: "SolvBTC", assetId: "", contract: "0x541fd749419ca806a8bc7da8ac23d346f2df8b77", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/36800/large/solvBTC.png?1719810684"},
      {symbol: "PENDLE", assetId: "", contract: "0xff9c599d51c407a45d631c6e89cb047efb88aef6", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/15069/large/Pendle_Logo_Normal-03.png?1696514728"},
      {symbol: "uniBTC", assetId: "", contract: "0xc3827a4bc8224ee2d116637023b124ced6db6e90", decimals: 8, icon: "https://coin-images.coingecko.com/coins/images/39599/large/uniBTC_200px.png?1723064455"},
      {symbol: "frxUSD", assetId: "", contract: "0x80eede496655fb9047dd39d9f418d5483ed600df", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/53963/large/frxUSD.png?1737792154"},
    ],
  },
  // ── Address-only L1s (no wallet adapter — exchange / any-wallet deposits),
  //    NEAR Intents routes; all verified live in the 1Click registry 2026-08.
  {
    key: "litecoin",
    caip2: "litecoin:mainnet",
    icon: chainIcon("litecoin"),
    label: "Litecoin",
    assets: [{symbol: "LTC", assetId: "nep141:ltc.omft.near", decimals: 8, icon: cmcIcon(2)}],
  },
  {
    key: "doge",
    caip2: "doge:mainnet",
    icon: chainIcon("doge"),
    label: "Dogecoin",
    assets: [{symbol: "DOGE", assetId: "nep141:doge.omft.near", decimals: 8, icon: cmcIcon(74)}],
  },
  {
    // XRP deposit addresses carry a destination tag — memo semantics.
    key: "xrp",
    caip2: "xrp:mainnet",
    icon: chainIcon("ripple"),
    label: "XRP",
    memo: true,
    assets: [{symbol: "XRP", assetId: "nep141:xrp.omft.near", decimals: 6, icon: cmcIcon(52)}],
  },
  {
    key: "bch",
    caip2: "bch:mainnet",
    icon: chainIcon("bitcoincash"),
    label: "Bitcoin Cash",
    assets: [{symbol: "BCH", assetId: "nep141:bch.omft.near", decimals: 8, icon: cmcIcon(1831)}],
  },
  {
    // THORChain-only (GAIA.ATOM pool): 1Click has no ATOM, so the assetId is
    // empty — the LI.FI-only convention nearIntents already skips on. Off-ramp
    // destination only until a provider can route ATOM deposits.
    key: "cosmos",
    caip2: "cosmos:cosmoshub-4",
    icon: chainIcon("cosmos"),
    label: "Cosmos",
    offrampOnly: true,
    assets: [{symbol: "ATOM", assetId: "", decimals: 6, icon: cmcIcon(3794)}],
  },
  {
    key: "cardano",
    caip2: "cardano:mainnet",
    icon: chainIcon("cardano"),
    label: "Cardano",
    assets: [{symbol: "ADA", assetId: "nep141:cardano.omft.near", decimals: 6, icon: cmcIcon(2010)}],
  },
  {
    // Stellar payments use memos (hot-bridge nep245 ids).
    key: "stellar",
    caip2: "stellar:pubnet",
    icon: chainIcon("stellar"),
    label: "Stellar",
    memo: true,
    assets: [
      {
        symbol: "XLM",
        assetId: "nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz",
        decimals: 7,
        icon: cmcIcon(512),
      },
      {
        symbol: "USDC",
        assetId: "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu",
        contract: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        decimals: 7,
        icon: cmcIcon(3408),
      },
    ],
  },
  {
    key: "aptos",
    caip2: "aptos:mainnet",
    icon: chainIcon("aptos"),
    label: "Aptos",
    assets: [
      {symbol: "APT", assetId: "nep141:aptos.omft.near", decimals: 8, icon: cmcIcon(21794)},
      {
        symbol: "USDT",
        assetId: "nep141:aptos-88cb7619440a914fe6400149a12b443c3ac21d59.omft.near",
        contract: "0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b",
        decimals: 6,
        icon: cmcIcon(825),
      },
      {
        symbol: "USDC",
        assetId: "nep141:aptos-34ee497f210c5a511e8d5b53bc56d75b63612bb5.omft.near",
        contract: "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b",
        decimals: 6,
        icon: cmcIcon(3408),
      },
    ],
  },
  {
    key: "sui",
    caip2: "sui:mainnet",
    icon: chainIcon("sui"),
    label: "Sui",
    assets: [
      {symbol: "SUI", assetId: "nep141:sui.omft.near", decimals: 9, icon: cmcIcon(20947)},
      {
        symbol: "USDC",
        assetId: "nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near",
        contract: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
        decimals: 6,
        icon: cmcIcon(3408),
      },
    ],
  },
  {
    // Robinhood Chain (Arbitrum-stack L2, native ETH). Wallet deposits switch
    // to chain 4663 via Reown; LI.FI and Omniston both route the chain.
    key: "robinhood",
    caip2: "eip155:4663",
    icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/robinhood.svg",
    label: "Robinhood",
    assets: [
      {symbol: "ETH", assetId: "", decimals: 18, icon: cmcIcon(1027)},
      {
        symbol: "WETH",
        assetId: "",
        contract: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
        decimals: 18,
        icon: cmcIcon(2396),
      },
      {
        symbol: "USDG",
        assetId: "",
        contract: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
        decimals: 6,
        icon: cmcIcon(33793), // Global Dollar — the mark LI.FI serves for it
      },
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "LINK", assetId: "", contract: "0x492641f648a4986844848e0befe66d14817bce34", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/877/large/Chainlink_Logo_500.png?1760023405"},
      {symbol: "cbBTC", assetId: "", contract: "0xcec185eb182c47d1ba1efc84e6959e18cd620be4", decimals: 8, icon: "https://coin-images.coingecko.com/coins/images/40143/large/cbbtc.webp?1726136727"},
      {symbol: "VIRTUAL", assetId: "", contract: "0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/34057/large/LOGOMARK.png?1708356054"},
      {symbol: "APE", assetId: "", contract: "0x8f86a15ec17cb3369d8b3e666dadbc11daa82b79", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/24383/large/APECOIN.png?1756551529"},
    ],
  },  {
    // zkSync Era (ZK-rollup, native ETH). LI.FI + Uniswap v3 (cp0x addresses) + wrap;
    // no 1Click ids. Tokens verified on-chain 2026-10-12 (symbol, decimals).
    key: "zksync",
    caip2: "eip155:324",
    icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/zksync.svg",
    label: "zkSync",
    assets: [
      {symbol: "ETH", assetId: "", decimals: 18, icon: cmcIcon(1027)},
      {symbol: "WETH", assetId: "", contract: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91", decimals: 18, icon: cmcIcon(2396)},
      {symbol: "USDC", assetId: "", contract: "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4", decimals: 6, icon: cmcIcon(3408)},
      {symbol: "USDT", assetId: "", contract: "0x493257fD37EDB34451f62EDf8D2a0C418852bA4C", decimals: 6, icon: cmcIcon(825)},
      {symbol: "WBTC", assetId: "", contract: "0xBBeB516fb02a01611cBBE0453Fe3c580D7281011", decimals: 8, icon: cmcIcon(3717)},
      {symbol: "ZK", assetId: "", contract: "0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E", decimals: 18, icon: cmcIcon(24091)},
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "LINK", assetId: "", contract: "0x52869bae3e091e36b0915941577f2d47d8d8b534", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/877/large/Chainlink_Logo_500.png?1760023405"},
      {symbol: "weETH", assetId: "", contract: "0xc1fa6e2e8667d9be0ca938a54c7e0285e9df924a", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33033/large/weETH.png?1701438396"},
      {symbol: "USDe", assetId: "", contract: "0x39fe7a0dacce31bd90418e3e659fb0b5f0b3db0d", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33613/large/usde.png?1733810059"},
      {symbol: "ENA", assetId: "", contract: "0x686b311f82b407f0be842652a98e5619f64cc25f", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/36530/large/ethena.png?1711701436"},
      {symbol: "sUSDe", assetId: "", contract: "0xad17da2f6ac76746ef261e835c50b2651ce36da8", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33669/large/sUSDe-Symbol-Color.png?1716307680"},
      {symbol: "Cake", assetId: "", contract: "0x3a287a06c66f9e95a56327185ca2bdf5f031cecd", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/12632/large/pancakeswap-cake-logo_%281%29.png?1696512440"},
      {symbol: "SolvBTC", assetId: "", contract: "0x74ed17608cc2b5f30a59d6af07c9ad1b1ab3a5b1", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/36800/large/solvBTC.png?1719810684"},
      {symbol: "frxUSD", assetId: "", contract: "0xea77c590bb36c43ef7139ce649cfbcfd6163170d", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/53963/large/frxUSD.png?1737792154"},
    ],
  },
  {
    // Celo (Ethereum L2). CELO is native AND an ERC-20 at 0x471E… — listed by its
    // contract, the way LI.FI and the Uniswap router see it (no wrapped native).
    key: "celo",
    caip2: "eip155:42220",
    icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/celo.svg",
    label: "Celo",
    assets: [
      {symbol: "CELO", assetId: "", contract: "0x471EcE3750Da237f93B8E339c536989b8978a438", decimals: 18, icon: cmcIcon(5567)},
      {symbol: "USDC", assetId: "", contract: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", decimals: 6, icon: cmcIcon(3408)},
      {symbol: "USDT", assetId: "", contract: "0x617f3112bf5397D0467D315cC709EF968D9ba546", decimals: 6, icon: cmcIcon(825)},
      {symbol: "USDm", assetId: "", contract: "0x765DE816845861e75A25fCA122bb6898B8B1282a", decimals: 18, icon: cmcIcon(7236)},
      {symbol: "WETH", assetId: "", contract: "0xD221812de1BD094f35587EE8E174B07B6167D9Af", decimals: 18, icon: cmcIcon(2396)},
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "LINK", assetId: "", contract: "0xd07294e6e917e07dfdcee882dd1e2565085c2ae0", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/877/large/Chainlink_Logo_500.png?1760023405"},
      {symbol: "XAUt0", assetId: "", contract: "0xaf37e8b6c9ed7f6318979f56fc287d76c30847ff", decimals: 6, icon: "https://coin-images.coingecko.com/coins/images/66560/large/XAUt0_Token_Icon_Gold.png?1749747942"},
      {symbol: "WBTC", assetId: "", contract: "0xBAAB46E28388d2779e6E31Fd00cF0e5Ad95E327B", decimals: 8, icon: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png"},
      {symbol: "DAI", assetId: "", contract: "0x90Ca507a5D4458a4C6C6249d186b6dCb02a5BCCd", decimals: 18, icon: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x6B175474E89094C44Da98b954EedeAC495271d0F/logo.png"},
    ],
  },
  {
    // MegaETH (real-time Ethereum L2, native ETH). LI.FI + wrap; no 1Click ids.
    key: "megaeth",
    caip2: "eip155:4326",
    icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/megaeth.svg",
    label: "MegaETH",
    assets: [
      {symbol: "ETH", assetId: "", decimals: 18, icon: cmcIcon(1027)},
      {symbol: "WETH", assetId: "", contract: "0x4200000000000000000000000000000000000006", decimals: 18, icon: cmcIcon(2396)},
      {symbol: "USDT0", assetId: "", contract: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", decimals: 6, icon: cmcIcon(825)},
      {symbol: "USDm", assetId: "", contract: "0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7", decimals: 18, icon: cmcIcon(7236)},
      {symbol: "USDe", assetId: "", contract: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", decimals: 18, icon: cmcIcon(29470)},
      {symbol: "MEGA", assetId: "", contract: "0x28B7E77f82B25B95953825F1E3eA0E36c1c29861", decimals: 18},
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "wstETH", assetId: "", contract: "0x601ac63637933d88285a025c685ac4e9a92a98da", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/18834/large/wstETH.png?1696518295"},
      {symbol: "LINK", assetId: "", contract: "0xee85aefb15b9489563a6a29891ebe0750aa1a7ae", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/877/large/Chainlink_Logo_500.png?1760023405"},
      {symbol: "BTC.b", assetId: "", contract: "0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072", decimals: 8, icon: "https://coin-images.coingecko.com/coins/images/26115/large/BTC.b.png?1772210755"},
      {symbol: "sUSDe", assetId: "", contract: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2", decimals: 18, icon: "https://static.debank.com/image/eth_token/logo_url/0x9d39a5de30e57443bff2a8307a4256c8797a3497/613e3c4b4b079a18bf8d7170d5b038bf.png"},
      {symbol: "rsETH", assetId: "", contract: "0xc3eACf0612346366Db554C991D7858716db09f58", decimals: 18, icon: "https://static.debank.com/image/stable_token/logo_url/0x9ecaf80c1303cca8791afbc0ad405c8a35e8d9f1/9b29efed86aff5a64f238d6d30032f40.png"},
      {symbol: "LBTC", assetId: "", contract: "0xecAc9C5F704e954931349Da37F60E39f515c11c1", decimals: 8},
    ],
  },
  {
    // Plasma (stablecoin L1, native XPL). LI.FI + wrap; 1Click lists XPL and USDT0 under the nep141 omft
    // bridge (2026-10-17 token list; the older nep245 HOT ids are marked DEPRECATED there) — dry quotes
    // Plasma→Base and Base→Plasma verified live. Verified on-chain 2026-10-13.
    key: "plasma",
    caip2: "eip155:9745",
    icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/plasma.svg",
    label: "Plasma",
    assets: [
      {symbol: "XPL", assetId: "nep141:plasma.omft.near", decimals: 18, icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/plasma.svg"},
      {symbol: "WXPL", assetId: "", contract: "0x6100E367285b01F48D07953803A2d8dCA5D19873", decimals: 18},
      {symbol: "USDT0", assetId: "nep141:plasma-0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb.omft.near", contract: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", decimals: 6, icon: cmcIcon(825)},
      {symbol: "USDe", assetId: "", contract: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", decimals: 18, icon: cmcIcon(29470)},
      {symbol: "WETH", assetId: "", contract: "0x9895D81bB462A195b4922ED7De0e3ACD007c32CB", decimals: 18, icon: cmcIcon(2396)},
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "LINK", assetId: "", contract: "0x76a443768a5e3b8d1aed0105fc250877841deb40", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/877/large/Chainlink_Logo_500.png?1760023405"},
      {symbol: "weETH", assetId: "", contract: "0xa3d68b74bf0528fdd07263c60d6488749044914b", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33033/large/weETH.png?1701438396"},
      {symbol: "sUSDe", assetId: "", contract: "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33669/large/sUSDe-Symbol-Color.png?1716307680"},
      {symbol: "rsETH", assetId: "", contract: "0x9ecaf80c1303cca8791afbc0ad405c8a35e8d9f1", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33800/large/Icon___Dark.png?1702991855"},
      {symbol: "GHO", assetId: "", contract: "0xb77e872a68c62cfc0dfb02c067ecc3da23b4bbf3", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/30663/large/gho-token-logo.png?1720517092"},
      {symbol: "XAUt0", assetId: "", contract: "0x1b64b9025eebb9a6239575df9ea4b9ac46d4d193", decimals: 6, icon: "https://coin-images.coingecko.com/coins/images/66560/large/XAUt0_Token_Icon_Gold.png?1749747942"},
    ],
  },
  {
    // Linea (zkEVM L2, native ETH). LI.FI + Uniswap v3 + wrap; no 1Click ids. Verified on-chain 2026-10-13.
    key: "linea",
    caip2: "eip155:59144",
    icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/linea.svg",
    label: "Linea",
    assets: [
      {symbol: "ETH", assetId: "", decimals: 18, icon: cmcIcon(1027)},
      {symbol: "WETH", assetId: "", contract: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f", decimals: 18, icon: cmcIcon(2396)},
      {symbol: "USDC", assetId: "", contract: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", decimals: 6, icon: cmcIcon(3408)},
      {symbol: "USDT", assetId: "", contract: "0xA219439258ca9da29E9Cc4cE5596924745e12B93", decimals: 6, icon: cmcIcon(825)},
      {symbol: "WBTC", assetId: "", contract: "0x3aAB2285ddcDdaD8edf438C1bAB47e1a9D05a9b4", decimals: 8, icon: cmcIcon(3717)},
      {symbol: "DAI", assetId: "", contract: "0x4AF15ec2A0BD43Db75dd04E62FAA3B8EF36b00d5", decimals: 18, icon: cmcIcon(4943)},
      {symbol: "LINEA", assetId: "", contract: "0x1789e0043623282D5DCc7F213d703C6D8BAfBB04", decimals: 18},
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "weETH", assetId: "", contract: "0x1bf74c010e6320bab11e2e5a532b5ac15e0b8aa6", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33033/large/weETH.png?1701438396"},
      {symbol: "sUSDe", assetId: "", contract: "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33669/large/sUSDe-Symbol-Color.png?1716307680"},
      {symbol: "Cake", assetId: "", contract: "0x0d1e753a25ebda689453309112904807625befbe", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/12632/large/pancakeswap-cake-logo_%281%29.png?1696512440"},
      {symbol: "M-BTC", assetId: "", contract: "0xe4d584ae9b753e549cae66200a6475d2f00705f7", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/36566/large/photo_2024-03-25_22-04-42.jpg?1711936162"},
      {symbol: "frxETH", assetId: "", contract: "0xb1afd04774c02ae84692619448b08ba79f19b1ff", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/28284/large/frxETH_icon.png?1696527284"},
      {symbol: "ezETH", assetId: "", contract: "0x2416092f143378750bb29b79ed961ab195cceea5", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/34753/large/Ezeth_logo_circle.png?1713496404"},
      {symbol: "frxUSD", assetId: "", contract: "0xc7346783f5e645aa998b106ef9e7f499528673d8", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/53963/large/frxUSD.png?1737792154"},
      {symbol: "xSolvBTC", assetId: "", contract: "0xcc0966d8418d412c599a6421b760a847eb169a8c", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/39384/large/xSolvBTC.png?1744170824"},
    ],
  },
  {
    // Sonic (native S). LI.FI + wrap S↔wS; USDC is Circle-native (CCTP). No 1Click ids. Verified on-chain 2026-10-13.
    key: "sonic",
    caip2: "eip155:146",
    icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/sonic.svg",
    label: "Sonic",
    assets: [
      {symbol: "S", assetId: "", decimals: 18, icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/sonic.svg"},
      {symbol: "wS", assetId: "", contract: "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38", decimals: 18},
      {symbol: "USDC", assetId: "", contract: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", decimals: 6, icon: cmcIcon(3408)},
      {symbol: "USDT", assetId: "", contract: "0x6047828dc181963ba44974801FF68e538dA5eaF9", decimals: 6, icon: cmcIcon(825)},
      {symbol: "WETH", assetId: "", contract: "0x50c42dEAcD8Fc9773493ED674b675bE577f2634b", decimals: 18, icon: cmcIcon(2396)},
      {symbol: "WBTC", assetId: "", contract: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c", decimals: 8, icon: cmcIcon(3717)},
      {symbol: "stS", assetId: "", contract: "0xE5DA20F15420aD15DE0fa650600aFc998bbE3955", decimals: 18},
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "LINK", assetId: "", contract: "0x71052bae71c25c78e37fd12e5ff1101a71d9018f", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/877/large/Chainlink_Logo_500.png?1760023405"},
      {symbol: "weETH", assetId: "", contract: "0xa3d68b74bf0528fdd07263c60d6488749044914b", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33033/large/weETH.png?1701438396"},
      {symbol: "rsETH", assetId: "", contract: "0xd75787ba9aba324420d522bda84c08c87e5099b1", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33800/large/Icon___Dark.png?1702991855"},
      {symbol: "LBTC", assetId: "", contract: "0xecac9c5f704e954931349da37f60e39f515c11c1", decimals: 8, icon: "https://coin-images.coingecko.com/coins/images/39969/large/lbtc-token-circle-200.png?1786635984"},
      {symbol: "FBTC", assetId: "", contract: "0xc96de26018a54d51c097160568752c4e3bd6c364", decimals: 8, icon: "https://coin-images.coingecko.com/coins/images/39182/large/Function_Token_%282%29.png?1760254065"},
      {symbol: "PENDLE", assetId: "", contract: "0xf1ef7d2d4c0c881cd634481e0586ed5d2871a74b", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/15069/large/Pendle_Logo_Normal-03.png?1696514728"},
      {symbol: "uniBTC", assetId: "", contract: "0xc3827a4bc8224ee2d116637023b124ced6db6e90", decimals: 8, icon: "https://coin-images.coingecko.com/coins/images/39599/large/uniBTC_200px.png?1723064455"},
      {symbol: "frxUSD", assetId: "", contract: "0x80eede496655fb9047dd39d9f418d5483ed600df", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/53963/large/frxUSD.png?1737792154"},
    ],
  },
  {
    // World Chain (OP Stack L2, native ETH). LI.FI + Uniswap v3 + wrap + CCTP; no 1Click ids. Verified on-chain 2026-10-13.
    key: "worldchain",
    caip2: "eip155:480",
    icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/world.svg",
    label: "World Chain",
    assets: [
      {symbol: "ETH", assetId: "", decimals: 18, icon: cmcIcon(1027)},
      {symbol: "WETH", assetId: "", contract: "0x4200000000000000000000000000000000000006", decimals: 18, icon: cmcIcon(2396)},
      {symbol: "USDC", assetId: "", contract: "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1", decimals: 6, icon: cmcIcon(3408)},
      {symbol: "WBTC", assetId: "", contract: "0x03C7054BCB39f7b2e5B2c7AcB37583e32D70Cfa3", decimals: 8, icon: cmcIcon(3717)},
      {symbol: "WLD", assetId: "", contract: "0x2cFc85d8E48F8EAB294be644d9E25C3030863003", decimals: 18},
    ],
  },
  {
    // Sei (EVM, native SEI). LI.FI + wrap + CCTP; no 1Click ids. Verified on-chain 2026-10-13.
    key: "sei",
    caip2: "eip155:1329",
    icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/sei.svg",
    label: "Sei",
    assets: [
      {symbol: "SEI", assetId: "", decimals: 18, icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/sei.svg"},
      {symbol: "WSEI", assetId: "", contract: "0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7", decimals: 18},
      {symbol: "USDC", assetId: "", contract: "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392", decimals: 6, icon: cmcIcon(3408)},
      {symbol: "USDT0", assetId: "", contract: "0x9151434b16b9763660705744891fA906F660EcC5", decimals: 6, icon: cmcIcon(825)},
      {symbol: "WETH", assetId: "", contract: "0x160345fC359604fC6e70E3c5fAcbdE5F7A9342d8", decimals: 18, icon: cmcIcon(2396)},
      {symbol: "WBTC", assetId: "", contract: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c", decimals: 8, icon: cmcIcon(3717)},
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "SolvBTC", assetId: "", contract: "0x541FD749419CA806a8bc7da8ac23D346f2dF8B77", decimals: 18, icon: "https://static.debank.com/image/bob_token/logo_url/0x59889b7021243db5b1e065385f918316cd90d46c/31a6cb7216c2b772a41a8913cc36f2c0.png"},
      {symbol: "USDT", assetId: "", contract: "0xB75D0B03c06A926e488e2659DF1A861F860bD3d1", decimals: 6, icon: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png"},
      {symbol: "iSEI", assetId: "", contract: "0x5Cf6826140C1C56Ff49C808A1A75407Cd1DF9423", decimals: 6, icon: "https://static.debank.com/image/sei_token/logo_url/0x5cf6826140c1c56ff49c808a1a75407cd1df9423/f4b3731501343f4ac86c9bcdaf02ed2a.png"},
      {symbol: "fastUSD", assetId: "", contract: "0x37a4dD9CED2b19Cfe8FAC251cd727b5787E45269", decimals: 18, icon: "https://static.debank.com/image/sei_token/logo_url/0x37a4dd9ced2b19cfe8fac251cd727b5787e45269/97f1966c1e35a9b6783994ce90e1d76e.png"},
    ],
  },
  {
    // Ink (OP Stack L2, native ETH). LI.FI + Uniswap v3 + wrap + CCTP; no 1Click ids. Verified on-chain 2026-10-13.
    key: "ink",
    caip2: "eip155:57073",
    icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/ink.svg",
    label: "Ink",
    assets: [
      {symbol: "ETH", assetId: "", decimals: 18, icon: cmcIcon(1027)},
      {symbol: "WETH", assetId: "", contract: "0x4200000000000000000000000000000000000006", decimals: 18, icon: cmcIcon(2396)},
      {symbol: "USDC", assetId: "", contract: "0x2D270e6886d130D724215A266106e6832161EAEd", decimals: 6, icon: cmcIcon(3408)},
      {symbol: "USDT0", assetId: "", contract: "0x0200C29006150606B650577BBE7B6248F58470c1", decimals: 6, icon: cmcIcon(825)},
      {symbol: "USDe", assetId: "", contract: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", decimals: 18, icon: cmcIcon(29470)},
      {symbol: "kBTC", assetId: "", contract: "0x73E0C0d45E048D25Fc26Fa3159b0aA04BfA4Db98", decimals: 8},
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "weETH", assetId: "", contract: "0xa3d68b74bf0528fdd07263c60d6488749044914b", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33033/large/weETH.png?1701438396"},
      {symbol: "USDG", assetId: "", contract: "0xe343167631d89b6ffc58b88d6b7fb0228795491d", decimals: 6, icon: "https://coin-images.coingecko.com/coins/images/51281/large/GDN_USDG_Token_200x200.png?1730484111"},
      {symbol: "PYUSD", assetId: "", contract: "0x142cdc44890978b506e745bb3bd11607b7f7faef", decimals: 6, icon: "https://coin-images.coingecko.com/coins/images/31212/large/PYUSD_Token_Logo_2x.png?1765987788"},
      {symbol: "rsETH", assetId: "", contract: "0xc3eacf0612346366db554c991d7858716db09f58", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33800/large/Icon___Dark.png?1702991855"},
      {symbol: "GHO", assetId: "", contract: "0xfc421ad3c883bf9e7c4f42de845c4e4405799e73", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/30663/large/gho-token-logo.png?1720517092"},
      {symbol: "reUSD", assetId: "", contract: "0x5bcf6b008bf80b9296238546bace1797657b05d6", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/66291/large/Points_Program_Group_91.png?1749676055"},
      {symbol: "uniBTC", assetId: "", contract: "0xd3c8da379d71a33bfee8875f87ac2748beb1d58d", decimals: 8, icon: "https://coin-images.coingecko.com/coins/images/39599/large/uniBTC_200px.png?1723064455"},
      {symbol: "XAUt0", assetId: "", contract: "0xf50258d3c1dd88946c567920b986a12e65b50dac", decimals: 6, icon: "https://coin-images.coingecko.com/coins/images/66560/large/XAUt0_Token_Icon_Gold.png?1749747942"},
    ],
  },
  {
    // Plume (RWA chain, native PLUME). LI.FI + wrap + CCTP; no 1Click ids. Verified on-chain 2026-10-13.
    key: "plume",
    caip2: "eip155:98866",
    icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/plume.svg",
    label: "Plume",
    assets: [
      {symbol: "PLUME", assetId: "", decimals: 18, icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/plume.svg"},
      {symbol: "WPLUME", assetId: "", contract: "0xEa237441c92CAe6FC17Caaf9a7acB3f953be4bd1", decimals: 18},
      {symbol: "USDC", assetId: "", contract: "0x222365EF19F7947e5484218551B56bb3965Aa7aF", decimals: 6, icon: cmcIcon(3408)},
      {symbol: "pUSD", assetId: "", contract: "0xdddD73F5Df1F0DC31373357beAC77545dC5A6f3F", decimals: 6},
      {symbol: "WETH", assetId: "", contract: "0xca59cA09E5602fAe8B629DeE83FfA819741f14be", decimals: 18, icon: cmcIcon(2396)},
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "USD1", assetId: "", contract: "0x111111d2bf19e43c34263401e0cad979ed1cdb61", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/54977/large/USD1_1000x1000_transparent.png?1749297002"},
      {symbol: "frxUSD", assetId: "", contract: "0x80eede496655fb9047dd39d9f418d5483ed600df", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/53963/large/frxUSD.png?1737792154"},
      {symbol: "mTBILL", assetId: "", contract: "0xe85f2b707ec5ae8e07238f99562264f304e30109", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/37839/large/mTBILL_token.png?1728417279"},
      {symbol: "XAUM", assetId: "", contract: "0xa0c4f78a29ead4abf6b7f5b3f0d05c0f3eab8ddf", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/51962/large/xaum_200px_logo_1x.png?1733560735"},
    ],
  },
  {
    // X Layer (OKX zkEVM, native OKB). LI.FI + Uniswap v3 + wrap + CCTP; no 1Click ids. Verified on-chain 2026-10-13.
    // 1Click does list OKB (nep245:v2_1.omni.hot.tg:196_11111111111111111111) and USDT0 (…:196_2fezDCvVYRsG8wrK6deJ2VRPiAS1)
    // via the HOT omni-bridge, but every HOT-bridge pair answers "Quoting for this pair is not available"
    // (2026-10-17 probe) — not mapped until that corridor quotes again. Its USDC is the bridged 0x74b7…, not ours.
    // USDC is Circle's native token (the CCTP one), not the older bridged "USD Coin" at 0x74b7…. LI.FI routes only
    // the bridged one (0 of 123 quotes for native USDC, 2026-10-13), so USDT0 leads as the swap stable here.
    key: "xlayer",
    caip2: "eip155:196",
    icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/xlayer.svg",
    label: "X Layer",
    assets: [
      {symbol: "OKB", assetId: "", decimals: 18, icon: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/xlayer.svg"},
      {symbol: "WOKB", assetId: "", contract: "0xe538905cf8410324e03A5A23C1c177a474D59b2b", decimals: 18},
      {symbol: "USDT0", assetId: "", contract: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", decimals: 6, icon: cmcIcon(825)},
      {symbol: "USDC", assetId: "", contract: "0xB6CEceAB302E2E4948951eE7843FC24E92933061", decimals: 6, icon: cmcIcon(3408)},
      {symbol: "WETH", assetId: "", contract: "0x5A77f1443D16ee5761d310e38b62f77f726bC71c", decimals: 18, icon: cmcIcon(2396)},
      {symbol: "WBTC", assetId: "", contract: "0xEA034fb02eB1808C2cc3adbC15f447B93CbE08e1", decimals: 8, icon: cmcIcon(3717)},
      // Top tokens by market cap (CoinGecko 2026-10-13), verified on-chain (symbol, decimals), routable via LI.FI / 1Click / Omniston.
      {symbol: "USDG", assetId: "", contract: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", decimals: 6, icon: "https://coin-images.coingecko.com/coins/images/51281/large/GDN_USDG_Token_200x200.png?1730484111"},
      {symbol: "sUSDe", assetId: "", contract: "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33669/large/sUSDe-Symbol-Color.png?1716307680"},
      {symbol: "rsETH", assetId: "", contract: "0x1b3a9a689ba7555f9d7984d7ad4025574ed5a0f9", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/33800/large/Icon___Dark.png?1702991855"},
      {symbol: "uniBTC", assetId: "", contract: "0xd3c8da379d71a33bfee8875f87ac2748beb1d58d", decimals: 8, icon: "https://coin-images.coingecko.com/coins/images/39599/large/uniBTC_200px.png?1723064455"},
      {symbol: "frxUSD", assetId: "", contract: "0x80eede496655fb9047dd39d9f418d5483ed600df", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/53963/large/frxUSD.png?1737792154"},
      {symbol: "brBTC", assetId: "", contract: "0xa161132371c94299d215915d4cbc3b629e2059be", decimals: 8, icon: "https://coin-images.coingecko.com/coins/images/53039/large/brBTC_200.png?1735074374"},
      {symbol: "sfrxUSD", assetId: "", contract: "0x5bff88ca1442c2496f7e475e9e7786383bc070c0", decimals: 18, icon: "https://coin-images.coingecko.com/coins/images/53964/large/sfrxUSD.png?1737792232"},
    ],
  },
];

/**
 * Wrapped native tokens (WETH9-style deposit/withdraw), verified on-chain
 * 2026-10-12 (symbol, 18 decimals, supply, deposit()). No 1Click id: only the
 * EVM venues route them (wrap 1:1, Uniswap, LI.FI) — NEAR Intents skips empty ids.
 */
const WRAPPED_NATIVE_ASSETS: Record<string, {symbol: string; contract: string; cmc: number}> = {
  "eip155:1": {symbol: "WETH", contract: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", cmc: 2396},
  "eip155:8453": {symbol: "WETH", contract: "0x4200000000000000000000000000000000000006", cmc: 2396},
  "eip155:10": {symbol: "WETH", contract: "0x4200000000000000000000000000000000000006", cmc: 2396},
  "eip155:42161": {symbol: "WETH", contract: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", cmc: 2396},
  "eip155:130": {symbol: "WETH", contract: "0x4200000000000000000000000000000000000006", cmc: 2396},
  "eip155:534352": {symbol: "WETH", contract: "0x5300000000000000000000000000000000000004", cmc: 2396},
  "eip155:56": {symbol: "WBNB", contract: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", cmc: 7192},
  "eip155:137": {symbol: "WPOL", contract: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", cmc: 28321},
  "eip155:43114": {symbol: "WAVAX", contract: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", cmc: 5805},
  "eip155:100": {symbol: "WXDAI", contract: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", cmc: 8635},
  "eip155:999": {symbol: "WHYPE", contract: "0x5555555555555555555555555555555555555555", cmc: 32196},
  "eip155:80094": {symbol: "WBERA", contract: "0x6969696969696969696969696969696969696969", cmc: 24647},
  "eip155:143": {symbol: "WMON", contract: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", cmc: 0},
};
for (const c of CC_SOURCE_CHAINS) {
  const w = WRAPPED_NATIVE_ASSETS[c.caip2];
  if (!w || c.assets.some((a) => a.symbol === w.symbol || a.contract?.toLowerCase() === w.contract.toLowerCase())) continue;
  const nativeIcon = c.assets.find((a) => !a.contract)?.icon;
  const icon = w.cmc ? cmcIcon(w.cmc) : nativeIcon;
  c.assets.push({symbol: w.symbol, assetId: "", contract: w.contract, decimals: 18, ...(icon ? {icon} : {})});
}

export const ETH_CAIP2 = "eip155:1";

/** Every non-Ethereum chain — deposit sources AND off-ramp destinations. */
export const CC_OTHER_CHAINS: CcChain[] = CC_SOURCE_CHAINS.filter(
  (c) => c.caip2 !== ETH_CAIP2 && !c.hidden,
);

/** Deposit pickers only — excludes off-ramp-only destinations. */
export const CC_DEPOSIT_CHAINS: CcChain[] = CC_OTHER_CHAINS.filter((c) => !c.offrampOnly);

/** Destination side: the vault always receives native ETH on Ethereum. */
export const CC_DEST = {
  caip2: ETH_CAIP2,
  assetId: "nep141:eth.omft.near",
  decimals: 18,
  token: "0x0000000000000000000000000000000000000000",
} as const;

export function ccChain(caip2: string): CcChain | undefined {
  return CC_SOURCE_CHAINS.find((c) => c.caip2 === caip2);
}

/**
 * Legacy symbols still arriving from older rows, balance services or third
 * parties, keyed by chain → what the catalog calls the asset today.
 * Toncoin was renamed Gram (GRAM) on 2026-06-15; the chain keeps the TON name.
 */
const LEGACY_SYMBOLS: Record<string, Record<string, string>> = {
  "ton:-239": {TON: "GRAM"},
};

/** The catalog's current symbol for a possibly-legacy one (identity otherwise). */
export function displaySymbol(caip2: string, symbol: string): string {
  return LEGACY_SYMBOLS[caip2]?.[symbol] ?? symbol;
}

export function ccAsset(caip2: string, symbol: string): CcAsset | undefined {
  const want = displaySymbol(caip2, symbol);
  return ccChain(caip2)?.assets.find((a) => a.symbol === want);
}

/**
 * Icon fallback for tokens a wallet can hold but the swap catalog does not
 * list (staking receipts and the like), by symbol. CoinMarketCap ids.
 */
const SYMBOL_ICONS: Record<string, number> = {
  GRAM: 11419,
  TON: 11419,
  tsTON: 38450,
  SSV: 12999,
  cSSV: 12999, // 1:1 staking receipt — SSV's mark
  stETH: 8085,
  wstETH: 12409,
  earnETH: 1027,
  earnUSD: 825,
};

export function iconForSymbol(symbol: string): string | undefined {
  const id = SYMBOL_ICONS[symbol] ?? SYMBOL_ICONS[symbol.toUpperCase()];
  return id ? cmcIcon(id) : undefined;
}

/**
 * Reverse lookup for the off-ramp: resolve a catalog asset by its on-chain token
 * id on a chain. `token` is an EVM/SVM contract (case-insensitive) or the zero
 * address / empty string for that chain's native asset. Providers use this to
 * turn an outbound (destChain, destToken) pair into their own asset notation.
 */
export function ccAssetByToken(caip2: string, token: string): CcAsset | undefined {
  const chain = ccChain(caip2);
  if (!chain) return undefined;
  const isNative = !token || /^0x0+$/.test(token);
  const want = token.toLowerCase();
  return chain.assets.find((a) =>
    // assetId equality as a safety net: a contract-less non-native entry must
    // never silently resolve to the native asset.
    isNative ? !a.contract : (a.contract ?? "").toLowerCase() === want || a.assetId === token,
  );
}

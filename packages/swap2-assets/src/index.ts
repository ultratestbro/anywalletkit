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

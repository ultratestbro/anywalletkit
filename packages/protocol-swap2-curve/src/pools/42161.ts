// TEMPORARY stand-in for the generated Arbitrum allowlist (replaced by the allowlist generator's output at merge).
// Coins, decimals and code hashes read on-chain 2026-11-05; TVL and creation from api.curve.finance (display only).
import type {CurveChainPools} from "./types.js";

export const POOLS_42161: CurveChainPools = {
  chainId: 42161,
  builtAt: "2026-11-05T00:00:00Z",
  block: 0,
  pools: [
    {address: "0x49b720F1Aab26260BEAec93A7BeB5BF2925b2A8F", name: "Strategic USD Reserves (USDC/USDT0)", coins: ["0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"], decimals: [6, 6], poolType: 10, swapTypes: [1], codeHash: "0x27724587b6447859a96567a97e5bf015b8e5ae3d90ffdbe97a098c30b268703c", tvlUsd: 257764, createdAt: 1739092049},
    {address: "0x7f90122BF0700F9E7e1F688fe926940E8839F353", name: "2pool (USDC.e/USDT0)", coins: ["0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"], decimals: [6, 6], poolType: 1, swapTypes: [1], codeHash: "0xc9c2956ac40175996b15ae3a750b84226736322c5c1aef3e6815b77aab3cb27e", tvlUsd: 630740, createdAt: 1631439440},
    {address: "0x73aF1150F265419Ef8a5DB41908B700C32D49135", name: "crvUSD/USDT0", coins: ["0x498Bf2B1e120FeD3ad3D42EA2165E9b73f99C1e5", "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"], decimals: [18, 6], poolType: 10, swapTypes: [1], codeHash: "0x73c60311d2b6a1dfa8e9de975d482b02218db1c78f24f2792d54954651ebdecf", tvlUsd: 222213, createdAt: 1703095286},
    {address: "0x82670f35306253222F8a165869B28c64739ac62e", name: "Tricrypto-crvUSD", coins: ["0x498Bf2B1e120FeD3ad3D42EA2165E9b73f99C1e5", "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"], decimals: [18, 8, 18], poolType: 30, swapTypes: [1], codeHash: "0x35da327ca48b6e428478467c3996176d71855383e82d30664f95886822fd507d", tvlUsd: 328552, createdAt: 1704150579},
  ],
};

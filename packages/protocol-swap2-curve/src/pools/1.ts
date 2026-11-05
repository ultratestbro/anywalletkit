// TEMPORARY stand-in for the generated Ethereum allowlist (replaced by the allowlist generator's output at merge).
// Coins, decimals and code hashes read on-chain 2026-11-05; TVL and creation from api.curve.finance (display only).
import type {CurveChainPools} from "./types.js";

export const POOLS_1: CurveChainPools = {
  chainId: 1,
  builtAt: "2026-11-05T00:00:00Z",
  block: 26349624,
  pools: [
    {address: "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7", name: "3pool", coins: ["0x6B175474E89094C44Da98b954EedeAC495271d0F", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0xdAC17F958D2ee523a2206206994597C13D831ec7"], decimals: [18, 6, 6], poolType: 1, swapTypes: [1], codeHash: "0x954a1e212c557c85043985931498ffa3e2fcbe7dfe9cd61513f36eb47d6f4dfc", tvlUsd: 161652599, createdAt: 1599422178},
    {address: "0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E", name: "crvUSD/USDC", coins: ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E"], decimals: [6, 18], poolType: 1, swapTypes: [1], codeHash: "0x06a0d9fefe2940f35a5e0b347ff8e2f8085c76ce487b5b234b2e3c831160e34f", tvlUsd: 13099337, createdAt: 1684066067},
    {address: "0x390f3595bCa2Df7d23783dFd126427CCeb997BF4", name: "crvUSD/USDT", coins: ["0xdAC17F958D2ee523a2206206994597C13D831ec7", "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E"], decimals: [6, 18], poolType: 1, swapTypes: [1], codeHash: "0x06a0d9fefe2940f35a5e0b347ff8e2f8085c76ce487b5b234b2e3c831160e34f", tvlUsd: 9818448, createdAt: 1684066103},
    {address: "0x21E27a5E5513D6e65C4f830167390997aA84843a", name: "stETH-ng", coins: ["0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84"], decimals: [18, 18], poolType: 1, swapTypes: [1], codeHash: "0x9e28a09452d2354fc4e15e3244dde27cbc4d52f12a10b91f2ca755b672bfa9be", tvlUsd: 22947196, createdAt: 1684243259},
    {address: "0xf5f5B97624542D72A9E06f04804Bf81baA15e2B4", name: "TricryptoUSDT", coins: ["0xdAC17F958D2ee523a2206206994597C13D831ec7", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"], decimals: [6, 8, 18], poolType: 30, swapTypes: [1], codeHash: "0xe5a06bd0c8f12bc66b551b99a34cdd7d2a286a53b778244c930a8f6db01fef40", tvlUsd: 13266539, createdAt: 1685482703},
    {address: "0x7F86Bf177Dd4F3494b841a37e810A34dD56c829B", name: "TricryptoUSDC", coins: ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"], decimals: [6, 8, 18], poolType: 30, swapTypes: [1], codeHash: "0xffceb70c60b48d7d02df8305161e44ec2454c1bc23fabc528e9a9ec71e4e7806", tvlUsd: 5114749, createdAt: 1685446211},
  ],
};

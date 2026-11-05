// TEMPORARY stand-in for the generated Monad allowlist (replaced by the allowlist generator's output at merge).
// Coins, decimals and code hashes read on-chain 2026-11-05; TVL from api2.curve.finance (display only).
import type {CurveChainPools} from "./types.js";

export const POOLS_143: CurveChainPools = {
  chainId: 143,
  builtAt: "2026-11-05T00:00:00Z",
  block: 0,
  pools: [
    {address: "0x942644106B073E30D72c2C5D7529D5C296ea91ab", name: "3pool (AUSD/USDC/USDT0)", coins: ["0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", "0xe7cd86e13AC4309349F30B3435a9d337750fC82D"], decimals: [6, 6, 6], poolType: 10, swapTypes: [1], codeHash: "0x93a67dae1693a9327ff151167502f6785ac856025182eebd61150f4e0ea92ffa", tvlUsd: 1442205},
    {address: "0xFd945d71D4E9609a1FAb0aE9c30dA8088E7AEE1E", name: "USDat/USDC", coins: ["0x0Bb150DFa86EA5d7742F07FEfCD8E8edA81D64eF", "0x754704Bc059F8C67012fEd69BC8A327a5aafb603"], decimals: [6, 6], poolType: 10, swapTypes: [1], codeHash: "0xd5d05317249e8e17bd8c67a05048a7115ec719e3f4198ddfa560b7c0b3b620f6", tvlUsd: 2349005},
  ],
};

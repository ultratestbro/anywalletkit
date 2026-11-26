export * from "./addresses.js";
export * from "./provider.js";
export {UniswapSwap2Protocol} from "./protocol.js";
export {UniswapSwap2Protocol as default} from "./protocol.js";
export * from "./activity.js";
export type { UniswapSwap2Config } from "./protocol.js"
// Uniswap v4 building blocks (UNISWAP-V4-RESEARCH §5.4); the rest of ./v4 stays internal.
export {UNISWAP_V4, UR_COMMANDS, V4_ACTIONS, UNISWAP_UR_SELECTORS, type UniswapV4Deployment} from "./v4/addresses.js";
export {poolIdOf, type V4PoolKey} from "./v4/pool.js";
export {encodeV4Swap} from "./v4/encode.js";
export {uniswapV4VerifyQuote} from "./v4/verify.js";

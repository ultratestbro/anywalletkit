// Aave v3 ABIs, hand-written from the protocol's interfaces (aave-v3-origin,
// `src/contracts/interfaces`). Only what a wallet needs. `getReserveData` keeps
// the `ReserveDataLegacy` layout the Pool has returned since v3.0, so one ABI
// serves every live market (3.0 … 3.4).
import { parseAbi } from 'viem'

export const POOL_ABI = parseAbi([
  'struct ReserveConfigurationMap { uint256 data; }',
  'struct UserConfigurationMap { uint256 data; }',
  'struct ReserveDataLegacy { ReserveConfigurationMap configuration; uint128 liquidityIndex; uint128 currentLiquidityRate; uint128 variableBorrowIndex; uint128 currentVariableBorrowRate; uint128 currentStableBorrowRate; uint40 lastUpdateTimestamp; uint16 id; address aTokenAddress; address stableDebtTokenAddress; address variableDebtTokenAddress; address interestRateStrategyAddress; uint128 accruedToTreasury; uint128 unbacked; uint128 isolationModeTotalDebt; }',
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function supplyWithPermit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode, uint256 deadline, uint8 permitV, bytes32 permitR, bytes32 permitS)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',
  'function repayWithPermit(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf, uint256 deadline, uint8 permitV, bytes32 permitR, bytes32 permitS) returns (uint256)',
  'function repayWithATokens(address asset, uint256 amount, uint256 interestRateMode) returns (uint256)',
  'function setUserUseReserveAsCollateral(address asset, bool useAsCollateral)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getReservesList() view returns (address[])',
  'function getReserveData(address asset) view returns (ReserveDataLegacy)',
  'function getUserConfiguration(address user) view returns (UserConfigurationMap)',
  'function getReserveNormalizedIncome(address asset) view returns (uint256)',
  'function ADDRESSES_PROVIDER() view returns (address)',
])

export const ADDRESSES_PROVIDER_ABI = parseAbi([
  'function getPool() view returns (address)',
  'function getPriceOracle() view returns (address)',
  'function getPoolDataProvider() view returns (address)',
  'function getMarketId() view returns (string)',
])

export const ORACLE_ABI = parseAbi([
  'function BASE_CURRENCY_UNIT() view returns (uint256)',
  'function getAssetPrice(address asset) view returns (uint256)',
  'function getAssetsPrices(address[] assets) view returns (uint256[])',
])

/**
 * WrappedTokenGatewayV3 as deployed with Aave v3.2+ (verified ABI of the
 * Ethereum gateway 0xd016…5722): `borrowETH` and `repayETH` no longer take an
 * interest-rate mode — the protocol docs still show the older signatures.
 * The first `address` argument of every method is unused (kept for ABI compat).
 */
export const GATEWAY_ABI = parseAbi([
  'function depositETH(address, address onBehalfOf, uint16 referralCode) payable',
  'function withdrawETH(address, uint256 amount, address to)',
  'function borrowETH(address, uint256 amount, uint16 referralCode)',
  'function repayETH(address, uint256 amount, address onBehalfOf) payable',
  'function getWETHAddress() view returns (address)',
])

export const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
])

/** Variable debt tokens: credit delegation the gateway needs to borrow native on your behalf. */
export const VARIABLE_DEBT_ABI = parseAbi([
  'function approveDelegation(address delegatee, uint256 amount)',
  'function borrowAllowance(address fromUser, address toUser) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
])

/** Aave v3 borrows at the variable rate only (stable mode was removed in 3.2). */
export const VARIABLE_RATE_MODE = 2n

/** Multicall3 — same address on every chain Aave v3 runs on except zkSync (the module falls back to single calls). */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const

// Morpho ABIs, hand-written from the protocol's interfaces: morpho-blue
// `src/interfaces/IMorpho.sol`, `IIrm.sol`, `IOracle.sol`; metamorpho
// `IMetaMorpho.sol` / `IMetaMorphoFactory.sol`; vault-v2 `IVaultV2.sol` /
// `IVaultV2Factory.sol`. Vaults of both generations are ERC-4626.
import { parseAbi } from 'viem'

export const MORPHO_ABI = parseAbi([
  'struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }',
  'function supply(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256 assetsSupplied, uint256 sharesSupplied)',
  'function withdraw(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn)',
  'function borrow(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256 assetsBorrowed, uint256 sharesBorrowed)',
  'function repay(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256 assetsRepaid, uint256 sharesRepaid)',
  'function supplyCollateral(MarketParams marketParams, uint256 assets, address onBehalf, bytes data)',
  'function withdrawCollateral(MarketParams marketParams, uint256 assets, address onBehalf, address receiver)',
  'function accrueInterest(MarketParams marketParams)',
  'function setAuthorization(address authorized, bool newIsAuthorized)',
  'function isAuthorized(address authorizer, address authorized) view returns (bool)',
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
  'function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
  'function isIrmEnabled(address irm) view returns (bool)',
  'function isLltvEnabled(uint256 lltv) view returns (bool)',
])

export const IRM_ABI = parseAbi([
  'struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }',
  'struct Market { uint128 totalSupplyAssets; uint128 totalSupplyShares; uint128 totalBorrowAssets; uint128 totalBorrowShares; uint128 lastUpdate; uint128 fee; }',
  'function borrowRateView(MarketParams marketParams, Market market) view returns (uint256)',
])

export const ORACLE_ABI = parseAbi(['function price() view returns (uint256)'])

/** ERC-4626 + ERC-20 surface every Morpho vault (V1 and V2) exposes. */
export const ERC4626_ABI = parseAbi([
  'function asset() view returns (address)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function convertToShares(uint256 assets) view returns (uint256)',
  'function previewDeposit(uint256 assets) view returns (uint256)',
  'function previewWithdraw(uint256 assets) view returns (uint256)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
  'function maxDeposit(address receiver) view returns (uint256)',
  'function maxWithdraw(address owner) view returns (uint256)',
  'function maxRedeem(address owner) view returns (uint256)',
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function mint(uint256 shares, address receiver) returns (uint256 assets)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)',
])

/** MetaMorpho (Vault V1) extras. */
export const VAULT_V1_ABI = parseAbi([
  'function MORPHO() view returns (address)',
  'function DECIMALS_OFFSET() view returns (uint8)',
  'function fee() view returns (uint96)',
  'function timelock() view returns (uint256)',
  'function curator() view returns (address)',
  'function guardian() view returns (address)',
  'function supplyQueueLength() view returns (uint256)',
  'function withdrawQueueLength() view returns (uint256)',
])

/** Vault V2 extras: fees and the transfer gates a deposit / withdrawal must pass. */
export const VAULT_V2_ABI = parseAbi([
  'function performanceFee() view returns (uint96)',
  'function managementFee() view returns (uint96)',
  'function curator() view returns (address)',
  'function liquidityAdapter() view returns (address)',
  'function adapterRegistry() view returns (address)',
  'function canReceiveShares(address account) view returns (bool)',
  'function canSendShares(address account) view returns (bool)',
  'function canReceiveAssets(address account) view returns (bool)',
  'function canSendAssets(address account) view returns (bool)',
])

export const FACTORY_V1_ABI = parseAbi(['function isMetaMorpho(address target) view returns (bool)', 'function MORPHO() view returns (address)'])
export const FACTORY_V2_ABI = parseAbi(['function isVaultV2(address account) view returns (bool)'])

export const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
])

import { parseAbi } from 'viem'

export const VAULT_ABI = parseAbi([
  'function shareManager() view returns (address)',
  'function feeManager() view returns (address)',
  'function oracle() view returns (address)',
  'function riskManager() view returns (address)',
  'function getAssetCount() view returns (uint256)',
  'function assetAt(uint256 index) view returns (address)',
  'function getQueueCount(address asset) view returns (uint256)',
  'function queueAt(address asset, uint256 index) view returns (address)',
  'function hasQueue(address queue) view returns (bool)',
  'function isDepositQueue(address queue) view returns (bool)',
  'function isPausedQueue(address queue) view returns (bool)',
])

export const SHARE_MANAGER_ABI = parseAbi([
  'function activeSharesOf(address account) view returns (uint256)',
  'function claimableSharesOf(address account) view returns (uint256)',
  'function sharesOf(address account) view returns (uint256)',
  'function activeShares() view returns (uint256)',
  // `flags()` returns a struct whose tail differs between deployed versions
  // (5 or 4 bools, then the lockups); it is read raw and the leading four
  // bools — mint pause, burn pause, transfer pause, whitelist — decoded.
  'function flags() view returns (bytes)',
])
/** keccak256('flags()')[0..4] */
export const FLAGS_SELECTOR = '0x64cc4aa5'

export const ORACLE_ABI = parseAbi([
  'function getReport(address asset) view returns ((uint224 priceD18, uint32 timestamp, bool isSuspicious))',
  'function securityParams() view returns ((uint208 absoluteDeviation, uint64 relativeDeviationD18, uint64 suspiciousAbsoluteDeviation, uint64 suspiciousRelativeDeviationD18, uint32 timeout, uint32 depositInterval, uint32 redeemInterval))',
])

export const FEE_MANAGER_ABI = parseAbi([
  'function depositFeeD6() view returns (uint24)',
  'function redeemFeeD6() view returns (uint24)',
  'function performanceFeeD6() view returns (uint24)',
  'function protocolFeeD6() view returns (uint24)',
])

export const DEPOSIT_QUEUE_ABI = parseAbi([
  'function deposit(uint224 assets, address referral, bytes32[] merkleProof) payable',
  'function cancelDepositRequest()',
  'function claimableOf(address account) view returns (uint256)',
  'function claim(address account) returns (bool)',
  'function requestOf(address account) view returns (uint256 timestamp, uint256 assets)',
])

export const REDEEM_QUEUE_ABI = parseAbi([
  'function redeem(uint256 shares)',
  'function requestsOf(address account, uint256 offset, uint256 limit) view returns ((uint256 timestamp, uint256 shares, bool isClaimable, uint256 assets)[])',
  'function claim(address receiver, uint32[] timestamps) returns (uint256)',
  'function getState() view returns (uint256 batchIterator, uint256 batches, uint256 demandedAssets, uint256 pendingShares)',
])

export const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
])

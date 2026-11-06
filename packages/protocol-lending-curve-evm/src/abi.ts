// ABIs hand-written from Yearn's VaultV3.vy 3.0.4 (the code scrvUSD clones; docs.curve.finance
// names commit 104a2b23 of yearn-Vaults-v3) and the ERC-20 surface crvUSD exposes.
//
// VaultV3 is Vyper: arguments with defaults compile to one selector per arity. `withdraw` and
// `redeem` take `max_loss` (basis points) after `owner`, and their defaults differ — 0 for
// withdraw, MAX_BPS (10 000 = any loss) for redeem. This module always passes max_loss = 0
// explicitly, so only the four-argument writes (and the two-argument max* views) are listed in
// VAULT_V3_ABI; activity.ts recognizes every arity.
import { parseAbi } from 'viem'

export const VAULT_V3_ABI = parseAbi([
  // ERC-20 / ERC-4626
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
  'function maxWithdraw(address owner, uint256 max_loss) view returns (uint256)',
  'function maxRedeem(address owner, uint256 max_loss) view returns (uint256)',
  'function deposit(uint256 assets, address receiver) returns (uint256)',
  'function withdraw(uint256 assets, address receiver, address owner, uint256 max_loss) returns (uint256)',
  'function redeem(uint256 shares, address receiver, address owner, uint256 max_loss) returns (uint256)',
  // VaultV3
  'function apiVersion() view returns (string)',
  'function isShutdown() view returns (bool)',
  'function totalIdle() view returns (uint256)',
  'function totalDebt() view returns (uint256)',
  'function pricePerShare() view returns (uint256)',
  'function profitMaxUnlockTime() view returns (uint256)',
  'function fullProfitUnlockDate() view returns (uint256)',
  'function profitUnlockingRate() view returns (uint256)',
  'function lastProfitUpdate() view returns (uint256)',
  'function role_manager() view returns (address)',
])

export const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
])

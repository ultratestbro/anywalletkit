// The Lido ABIs this module calls, as human-readable signatures (same text the
// ethers build used — selectors and calldata are byte-identical).
import { parseAbi } from 'viem'

export const STETH_ABI = parseAbi([
  'function submit(address _referral) payable returns (uint256)',
  'function balanceOf(address _account) view returns (uint256)',
  'function allowance(address _owner, address _spender) view returns (uint256)',
  'function approve(address _spender, uint256 _amount) returns (bool)',
  'function nonces(address _owner) view returns (uint256)',
  'function isStakingPaused() view returns (bool)',
  'function getCurrentStakeLimit() view returns (uint256)',
])

export const WSTETH_ABI = parseAbi([
  'function wrap(uint256 _stETHAmount) returns (uint256)',
  'function unwrap(uint256 _wstETHAmount) returns (uint256)',
  'function balanceOf(address _account) view returns (uint256)',
  'function allowance(address _owner, address _spender) view returns (uint256)',
  'function approve(address _spender, uint256 _amount) returns (bool)',
  'function nonces(address _owner) view returns (uint256)',
  'function stEthPerToken() view returns (uint256)',
])

export const WITHDRAWAL_QUEUE_ABI = parseAbi([
  'function requestWithdrawals(uint256[] _amounts, address _owner) returns (uint256[])',
  'function requestWithdrawalsWithPermit(uint256[] _amounts, address _owner, (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) _permit) returns (uint256[])',
  'function requestWithdrawalsWstETH(uint256[] _amounts, address _owner) returns (uint256[])',
  'function requestWithdrawalsWstETHWithPermit(uint256[] _amounts, address _owner, (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) _permit) returns (uint256[])',
  'function getWithdrawalRequests(address _owner) view returns (uint256[])',
  'function getWithdrawalStatus(uint256[] _requestIds) view returns ((uint256 amountOfStETH, uint256 amountOfShares, address owner, uint256 timestamp, bool isFinalized, bool isClaimed)[])',
  'function getLastCheckpointIndex() view returns (uint256)',
  'function findCheckpointHints(uint256[] _requestIds, uint256 _firstIndex, uint256 _lastIndex) view returns (uint256[])',
  'function getClaimableEther(uint256[] _requestIds, uint256[] _hints) view returns (uint256[])',
  'function claimWithdrawals(uint256[] _requestIds, uint256[] _hints)',
])

/** EIP-2612 permit typed-data types, as the stETH / wstETH tokens verify them. */
export const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

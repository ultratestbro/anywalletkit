import { parseAbi } from 'viem'

// The delegator-facing surface of the staking precompile. Every function is `nonpayable` (or
// `payable` for delegate), the getters included: a `view` would make toolchains emit STATICCALL,
// which the precompile rejects.
export const STAKING_ABI = parseAbi([
  'function delegate(uint64 validatorId) payable returns (bool success)',
  'function undelegate(uint64 validatorId, uint256 amount, uint8 withdrawId) returns (bool success)',
  'function withdraw(uint64 validatorId, uint8 withdrawId) returns (bool success)',
  'function compound(uint64 validatorId) returns (bool success)',
  'function claimRewards(uint64 validatorId) returns (bool success)',
  'function getEpoch() returns (uint64 epoch, bool inEpochDelayPeriod)',
  'function getValidator(uint64 validatorId) returns (address authAddress, uint64 flags, uint256 stake, uint256 accRewardPerToken, uint256 commission, uint256 unclaimedRewards, uint256 consensusStake, uint256 consensusCommission, uint256 snapshotStake, uint256 snapshotCommission, bytes secpPubkey, bytes blsPubkey)',
  'function getDelegator(uint64 validatorId, address delegator) returns (uint256 stake, uint256 accRewardPerToken, uint256 unclaimedRewards, uint256 deltaStake, uint256 nextDeltaStake, uint64 deltaEpoch, uint64 nextDeltaEpoch)',
  'function getWithdrawalRequest(uint64 validatorId, address delegator, uint8 withdrawId) returns (uint256 withdrawalAmount, uint256 accRewardPerToken, uint64 withdrawEpoch)',
  'function getConsensusValidatorSet(uint32 startIndex) returns (bool isDone, uint32 nextIndex, uint64[] valIds)',
  'function getSnapshotValidatorSet(uint32 startIndex) returns (bool isDone, uint32 nextIndex, uint64[] valIds)',
  'function getExecutionValidatorSet(uint32 startIndex) returns (bool isDone, uint32 nextIndex, uint64[] valIds)',
  'function getDelegations(address delegator, uint64 startValId) returns (bool isDone, uint64 nextValId, uint64[] valIds)',
  'event Delegate(uint64 indexed validatorId, address indexed delegator, uint256 amount, uint64 activationEpoch)',
  'event Undelegate(uint64 indexed validatorId, address indexed delegator, uint8 withdrawId, uint256 amount, uint64 activationEpoch)',
  'event Withdraw(uint64 indexed validatorId, address indexed delegator, uint8 withdrawId, uint256 amount, uint64 withdrawEpoch)',
  'event ClaimRewards(uint64 indexed validatorId, address indexed delegator, uint256 amount, uint64 epoch)',
])

/** 4-byte selectors of the delegator writes (as published by Monad, checked by the tests). */
export const SELECTORS = {
  delegate: '0x84994fec',
  undelegate: '0x5cf41514',
  withdraw: '0xaed2ee73',
  compound: '0xb34fea67',
  claimRewards: '0xa76e2ca5',
} as const

/** Event topics (keccak of the signature). */
export const TOPICS = {
  Delegate: '0xe4d4df1e1827dd28252fd5c3cd7ebccd3da6e0aa31f74c828f3c8542af49d840',
  Undelegate: '0x3e53c8b91747e1b72a44894db10f2a45fa632b161fdcdd3a17bd6be5482bac62',
  Withdraw: '0x63030e4238e1146c63f38f4ac81b2b23c8be28882e68b03f0887e50d0e9bb18f',
} as const

/** Revert strings the precompile returns, with what to tell the user. */
export const REVERTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/withdrawal not ready/i, 'This withdrawal is not ready yet: it opens one epoch after the stake deactivates.'],
  [/unknown withdrawal id/i, 'There is no withdrawal with this id.'],
  [/withdrawal id exists/i, 'This withdrawal id is already in use: claim it first or use another one.'],
  [/insufficient stake/i, 'Not enough active stake: stake that is still activating cannot be undelegated yet.'],
  [/delegation is too small/i, 'The amount is below the 1 gwei minimum.'],
  [/unknown validator/i, 'There is no validator with this id.'],
  [/reserve balance/i, 'Monad keeps a 10 MON reserve on every account: the wallet would end below it.'],
]

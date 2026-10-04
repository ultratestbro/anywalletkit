'use strict'

/** @typedef {import('./src/approvals-protocol.js').Approval} Approval */
/** @typedef {import('./src/approvals-protocol.js').ApprovalStandard} ApprovalStandard */
/** @typedef {import('./src/approvals-protocol.js').ApprovalRisk} ApprovalRisk */
/** @typedef {import('./src/approvals-protocol.js').ApprovalsResult} ApprovalsResult */
/** @typedef {import('./src/approvals-protocol.js').RevokeResult} RevokeResult */
/** @typedef {import('./src/approvals-protocol-evm.js').ApprovalsProtocolEvmConfig} ApprovalsProtocolEvmConfig */

export { default as ApprovalsProtocol, IApprovalsProtocol, ApprovalsError } from './src/approvals-protocol.js'
export { default as RpcLogsSource, parseApprovalLog } from './src/sources/rpc-logs.js'
export { default as IndexerLogsSource } from './src/sources/indexer-logs.js'
export { default as BlockscoutSource, BLOCKSCOUT_HOSTS } from './src/sources/blockscout.js'
export { default as EtherscanSource, ETHERSCAN_V2_URL } from './src/sources/etherscan.js'
export { default as StateVerifier } from './src/state-verifier.js'
export { default as EtherscanLabels } from './src/labels/etherscan.js'
export { approvalsHygienePolicy, isRevokeCalldata, isUnlimitedAmount } from './src/policies.js'
export * as STANDARDS from './src/standards.js'

export { default } from './src/approvals-protocol-evm.js'

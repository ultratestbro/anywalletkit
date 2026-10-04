'use strict'

import { Interface, getAddress, id, zeroPadValue } from 'ethers'

/** Uniswap Permit2 — the same address on every EVM chain it is deployed to. */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
/** Multicall3 — the same address on every major EVM chain. */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11'
/** An ERC-20 allowance at or above this is treated as unlimited (2^255). */
export const UNLIMITED_THRESHOLD = 1n << 255n
export const MAX_UINT160 = (1n << 160n) - 1n
export const MAX_UINT256 = (1n << 256n) - 1n
/** Code prefix of an EIP-7702 delegated account: 0xef0100 ‖ delegate. */
export const EIP7702_PREFIX = '0xef0100'
export const ERC1155_INTERFACE_ID = '0xd9b67a26'
export const ERC721_INTERFACE_ID = '0x80ac58cd'

/** Event signatures. `approval` is shared by ERC-20 and ERC-721 (3 vs 4 topics). */
export const TOPICS = Object.freeze({
  approval: id('Approval(address,address,uint256)'),
  approvalForAll: id('ApprovalForAll(address,address,bool)'),
  permit2Approval: id('Approval(address,address,address,uint160,uint48)'),
  permit2Permit: id('Permit(address,address,address,uint160,uint48,uint48)'),
  permit2Lockdown: id('Lockdown(address,address,address)')
})
/** Every topic0 the discovery filter asks for (owner is topic1 in all of them). */
export const DISCOVERY_TOPICS = Object.freeze(Object.values(TOPICS))

export const ERC20_ABI = new Interface([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)'
])

export const ERC721_ABI = new Interface([
  'function getApproved(uint256 tokenId) view returns (address)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function approve(address to, uint256 tokenId)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)'
])

export const PERMIT2_ABI = new Interface([
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function lockdown((address token, address spender)[] approvals)'
])

export const MULTICALL3_ABI = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)'
])

/** Function selectors a policy condition can recognise a revoke by. */
export const SELECTORS = Object.freeze({
  /** `approve(address,uint256)` — ERC-20 and ERC-721 share it. */
  approve: '0x095ea7b3',
  setApprovalForAll: '0xa22cb465',
  lockdown: PERMIT2_ABI.getFunction('lockdown').selector
})

/** The owner as an indexed topic (left-padded to 32 bytes). */
export function ownerTopic (owner) {
  return zeroPadValue(getAddress(owner), 32)
}

/** The address packed in an indexed topic. */
export function topicAddress (topic) {
  return getAddress('0x' + topic.slice(-40))
}

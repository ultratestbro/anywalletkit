import { getAbiItem, getAddress, keccak256, pad, parseAbi, stringToHex, toFunctionSelector, type Hex } from 'viem'

/**
 * Uniswap Permit2 at its CREATE2 address — the same on every EVM chain it is deployed to, zkSync Era
 * included (deployed there through the EVM emulator). Uniswap's own zkSync Era Permit2 is
 * {@link PERMIT2_ZKSYNC_ADDRESS}; see {@link permit2AddressesFor}.
 */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
/**
 * The Permit2 Uniswap documents for zkSync Era (eip155:324), compiled for EraVM: the CREATE2 address
 * does not carry over to zkSync's address derivation. No code at this address on any other chain.
 */
export const PERMIT2_ZKSYNC_ADDRESS = '0x0000000000225e31D15943971F47aD3022F714Fa'
/** zkSync Era mainnet. */
const ZKSYNC_ERA = 324
/** Every Permit2 contract the module knows, on any chain. */
export const PERMIT2_ADDRESSES: readonly string[] = Object.freeze([PERMIT2_ADDRESS, PERMIT2_ZKSYNC_ADDRESS])
const CANONICAL_ONLY: readonly string[] = Object.freeze([PERMIT2_ADDRESS])

/** `324`, `'324'`, `'0x144'` or `'eip155:324'` → 324; anything else → NaN. */
function chainNumber (chainId: number | string | undefined): number {
  if (typeof chainId === 'number') return chainId
  if (typeof chainId !== 'string' || chainId === '') return NaN
  return Number(chainId.replace(/^eip155:/, ''))
}

/**
 * The Permit2 Uniswap documents for a chain: {@link PERMIT2_ZKSYNC_ADDRESS} on zkSync Era,
 * {@link PERMIT2_ADDRESS} everywhere else.
 */
export function permit2AddressFor (chainId: number | string): string {
  return chainNumber(chainId) === ZKSYNC_ERA ? PERMIT2_ZKSYNC_ADDRESS : PERMIT2_ADDRESS
}

/**
 * Every live Permit2 on a chain. zkSync Era has two — the CREATE2 one and Uniswap's EraVM build, both
 * with their own allowances — so a scan, a revoke and an activity label must accept either there;
 * every other chain has only {@link PERMIT2_ADDRESS}.
 */
export function permit2AddressesFor (chainId: number | string | undefined): readonly string[] {
  return chainNumber(chainId) === ZKSYNC_ERA ? PERMIT2_ADDRESSES : CANONICAL_ONLY
}

/** True when `address` is one of the chain's Permit2 contracts ({@link permit2AddressesFor}). */
export function isPermit2Address (address: string | undefined, chainId: number | string | undefined): boolean {
  if (typeof address !== 'string') return false
  const a = address.toLowerCase()
  return permit2AddressesFor(chainId).some((p) => p.toLowerCase() === a)
}
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

/** keccak256 of the UTF-8 signature — the event's topic0 (ethers' `id`). */
const id = (signature: string): Hex => keccak256(stringToHex(signature))

/** Event signatures. `approval` is shared by ERC-20 and ERC-721 (3 vs 4 topics). */
export const TOPICS: Readonly<{ approval: Hex; approvalForAll: Hex; permit2Approval: Hex; permit2Permit: Hex; permit2Lockdown: Hex }> = Object.freeze({
  approval: id('Approval(address,address,uint256)'),
  approvalForAll: id('ApprovalForAll(address,address,bool)'),
  permit2Approval: id('Approval(address,address,address,uint160,uint48)'),
  permit2Permit: id('Permit(address,address,address,uint160,uint48,uint48)'),
  permit2Lockdown: id('Lockdown(address,address,address)')
})
/** Every topic0 the discovery filter asks for (owner is topic1 in all of them). */
export const DISCOVERY_TOPICS: readonly Hex[] = Object.freeze(Object.values(TOPICS))

export const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)'
])

export const ERC721_ABI = parseAbi([
  'function getApproved(uint256 tokenId) view returns (address)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function approve(address to, uint256 tokenId)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)'
])

export const PERMIT2_ABI = parseAbi([
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function lockdown((address token, address spender)[] approvals)'
])

export const MULTICALL3_ABI = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)'
])

/** Function selectors a policy condition can recognise a revoke by. */
export const SELECTORS: Readonly<{ approve: Hex; setApprovalForAll: Hex; lockdown: Hex }> = Object.freeze({
  /** `approve(address,uint256)` — ERC-20 and ERC-721 share it. */
  approve: '0x095ea7b3' as Hex,
  setApprovalForAll: '0xa22cb465' as Hex,
  lockdown: toFunctionSelector(getAbiItem({ abi: PERMIT2_ABI, name: 'lockdown' }))
})

/** The owner as an indexed topic (left-padded to 32 bytes, lowercase). */
export function ownerTopic (owner: string): Hex {
  return pad(getAddress(owner), { size: 32 }).toLowerCase() as Hex
}

/** The address packed in an indexed topic. */
export function topicAddress (topic: string): string {
  return getAddress('0x' + topic.slice(-40))
}

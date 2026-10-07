import { encodeFunctionData, parseAbi } from 'viem'

export const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
])

/** EIP-2612 surface (+ the `version()` some tokens expose; the fallback is '1'). */
export const ERC20_PERMIT_ABI = parseAbi([
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function nonces(address owner) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
])

export const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export const USDT_MAINNET = '0xdac17f958d2ee523a2206206994597c13d831ec7'

export const encodeTransfer = (to: `0x${string}`, amount: bigint) =>
  encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, amount] })
export const encodeApprove = (spender: `0x${string}`, amount: bigint) =>
  encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] })

import { encodeFunctionData, parseAbi } from 'viem'

export const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

export const USDT_MAINNET = '0xdac17f958d2ee523a2206206994597c13d831ec7'

export const encodeTransfer = (to: `0x${string}`, amount: bigint) =>
  encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, amount] })
export const encodeApprove = (spender: `0x${string}`, amount: bigint) =>
  encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] })

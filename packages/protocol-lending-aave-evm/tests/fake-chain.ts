// An in-memory EVM "node" exposed as an EIP-1193 provider: contracts are
// (address, abi, handler) triples, `eth_call` decodes the calldata and encodes
// the handler's answer, Multicall3.aggregate3 fans out internally, and a
// handler may throw `revert(...)` to produce a real `Error(string)` / custom
// error revert the way a node would.
import {
  decodeFunctionData, encodeErrorResult, encodeFunctionResult, getAddress, parseAbi, toFunctionSelector,
  type Abi, type Address, type EIP1193Provider, type Hex,
} from 'viem'

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address
const MULTICALL_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])

export class Revert extends Error {
  constructor(readonly data: Hex) { super('execution reverted') }
}

/** Revert with `Error(string)` (Aave ≤3.3 numeric codes) … */
export function revertString(message: string): never {
  throw new Revert(encodeErrorResult({ abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string', name: 'm' }] }], errorName: 'Error', args: [message] }))
}
/** … or with a parameterless custom error (Aave 3.4+). */
export function revertCustom(name: string): never {
  throw new Revert(toFunctionSelector(`${name}()`))
}

type Handler = (fn: string, args: readonly unknown[], ctx: { from?: Address; value: bigint }) => unknown

export class FakeChain {
  readonly contracts = new Map<string, { abi: Abi; handler: Handler }>()
  readonly calls: Array<{ to: Address; fn: string; args: readonly unknown[]; from?: Address; value: bigint }> = []
  chainId = 1

  on(address: Address, abi: Abi, handler: Handler): this {
    this.contracts.set(address.toLowerCase(), { abi, handler })
    return this
  }

  private dispatch(to: Address, data: Hex, ctx: { from?: Address; value: bigint }): Hex {
    const c = this.contracts.get(to.toLowerCase())
    if (!c) throw new Revert('0x')
    const { functionName, args = [] } = decodeFunctionData({ abi: c.abi, data })
    this.calls.push({ to: getAddress(to), fn: functionName, args, ...(ctx.from ? { from: ctx.from } : {}), value: ctx.value })
    const result = c.handler(functionName, args, ctx)
    return encodeFunctionResult({ abi: c.abi, functionName, result: result as never })
  }

  /** The EIP-1193 surface viem's `custom()` transport talks to. */
  readonly provider: EIP1193Provider = {
    request: (async ({ method, params }: { method: string; params?: unknown }) => {
      switch (method) {
        case 'eth_chainId': return `0x${this.chainId.toString(16)}`
        case 'eth_blockNumber': return '0x10'
        case 'eth_call': {
          const [tx] = params as [{ to: Address; data: Hex; from?: Address; value?: Hex }]
          const ctx = { ...(tx.from ? { from: getAddress(tx.from) } : {}), value: tx.value ? BigInt(tx.value) : 0n }
          if (tx.to.toLowerCase() === MULTICALL3.toLowerCase()) {
            const { args } = decodeFunctionData({ abi: MULTICALL_ABI, data: tx.data })
            const calls = args![0] as Array<{ target: Address; allowFailure: boolean; callData: Hex }>
            const out = calls.map((c) => {
              try { return { success: true, returnData: this.dispatch(c.target, c.callData, ctx) } } catch (e) {
                if (e instanceof Revert && c.allowFailure) return { success: false, returnData: e.data }
                throw e
              }
            })
            return encodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', result: out })
          }
          try {
            return this.dispatch(tx.to, tx.data, ctx)
          } catch (e) {
            if (e instanceof Revert) throw Object.assign(new Error('execution reverted'), { code: 3, data: e.data })
            throw e
          }
        }
        default: throw new Error(`fake chain: unsupported method ${method}`)
      }
    }) as EIP1193Provider['request'],
    on: () => undefined as never,
    removeListener: () => undefined as never,
  } as unknown as EIP1193Provider

  /** Calls recorded for a function name (any contract). */
  of(fn: string) { return this.calls.filter((c) => c.fn === fn) }
}

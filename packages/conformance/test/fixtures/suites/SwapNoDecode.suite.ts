import { describeProtocolBehaviour } from '../../../src/index.js'
import { ROUTER, Swap, USDC, fixture } from './swap-modules.js'

describeProtocolBehaviour('SwapNoDecode', { type: 'swap2', Protocol: Swap as never, config: { mode: 'honest' }, fixtures: [fixture('router calldata, no decode', { spender: ROUTER, sourceToken: USDC })] })

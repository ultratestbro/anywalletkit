import { describeProtocolBehaviour } from '../../../src/index.js'
import { ROUTER, Swap, USDC, exactInputRecipient, fixture } from './swap-modules.js'

describeProtocolBehaviour('SwapRouterPaysOther', { type: 'swap2', Protocol: Swap as never, config: { mode: 'router' }, fixtures: [fixture('router calldata pays another address', { spender: ROUTER, sourceToken: USDC, decode: exactInputRecipient })] })

import { describeProtocolBehaviour } from '../../../src/index.js'
import { ROUTER, Swap, USDC, exactInputRecipient, fixture } from './swap-modules.js'

describeProtocolBehaviour('SwapHonest', { type: 'swap2', Protocol: Swap as never, config: { mode: 'honest' }, fixtures: [fixture('router calldata pays the account', { spender: ROUTER, sourceToken: USDC, decode: exactInputRecipient })] })

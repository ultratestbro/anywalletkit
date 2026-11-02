import { describeProtocolBehaviour } from '../../../src/index.js'
import { ME, ROUTER, Swap, fixture } from './swap-modules.js'

// The fixture's decode vouches for the account and declares only the router: the undeclared contract and its native value still fail.
describeProtocolBehaviour('SwapStranger', { type: 'swap2', Protocol: Swap as never, config: { mode: 'stranger' }, fixtures: [fixture('native value into an undeclared contract', { callTargets: [ROUTER], decode: () => [ME] })] })

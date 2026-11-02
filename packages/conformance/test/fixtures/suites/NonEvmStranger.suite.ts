import { describeProtocolBehaviour } from '../../../src/index.js'
import { ME_TRON, TRON_ROUTER, TRON_STRANGER, planFixture, planModule, tronCall } from './plan-modules.js'

// A Tron call with native value into a contract no fixture declared: the decode is honest (it pays the account), the target is not.
describeProtocolBehaviour('NonEvmStranger', { type: 'swap2', Protocol: planModule(tronCall(TRON_STRANGER)) as never, config: {},
  fixtures: [planFixture('tron: native value into an undeclared contract', { account: { address: ME_TRON, chain: 'tron:mainnet' }, callTargets: [TRON_ROUTER], decode: () => [ME_TRON] })] })

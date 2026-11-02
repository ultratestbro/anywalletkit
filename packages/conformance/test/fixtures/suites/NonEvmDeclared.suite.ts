import { describeProtocolBehaviour } from '../../../src/index.js'
import { ME_TRON, TRON_ROUTER, planFixture, planModule, tronCall } from './plan-modules.js'

// Control: the same Tron call into the declared router passes.
describeProtocolBehaviour('NonEvmDeclared', { type: 'swap2', Protocol: planModule(tronCall(TRON_ROUTER)) as never, config: {},
  fixtures: [planFixture('tron: native value into the declared router', { account: { address: ME_TRON, chain: 'tron:mainnet' }, callTargets: [TRON_ROUTER], decode: () => [ME_TRON] })] })

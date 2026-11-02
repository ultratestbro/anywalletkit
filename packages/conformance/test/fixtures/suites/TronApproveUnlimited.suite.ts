import { describeProtocolBehaviour } from '../../../src/index.js'
import { ME_TRON, TRON_ROUTER, TRON_ROUTER_HEX, TRON_USDT, planFixture, planModule, tronApprove } from './plan-modules.js'

// A Tron call to the source token approving the declared spender for more than the input.
const tron = { account: { address: ME_TRON, chain: 'tron:mainnet' }, spender: TRON_ROUTER, sourceToken: TRON_USDT, callTargets: [TRON_ROUTER], decode: () => [ME_TRON] }
describeProtocolBehaviour('TronApproveUnlimited', { type: 'swap2', Protocol: planModule(tronApprove(TRON_ROUTER_HEX, () => (1n << 256n) - 1n)) as never, config: {},
  fixtures: [planFixture('tron: approve(declared spender, max)', tron)] })
describeProtocolBehaviour('TronApproveExcess', { type: 'swap2', Protocol: planModule(tronApprove(TRON_ROUTER_HEX, (a) => a + 1n)) as never, config: {},
  fixtures: [planFixture('tron: approve(declared spender, input + 1)', tron)] })

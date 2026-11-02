import { describeProtocolBehaviour } from '../../../src/index.js'
import { ME_TRON, TRON_ROUTER, TRON_ROUTER_HEX, TRON_USDT, planFixture, planModule, tronApprove } from './plan-modules.js'

// Control: a Tron approve / increaseAllowance of exactly the input to the declared spender passes.
const tron = { account: { address: ME_TRON, chain: 'tron:mainnet' }, spender: TRON_ROUTER, sourceToken: TRON_USDT, callTargets: [TRON_ROUTER], decode: () => [ME_TRON] }
describeProtocolBehaviour('TronApproveExact', { type: 'swap2', Protocol: planModule(tronApprove(TRON_ROUTER_HEX, (a) => a)) as never, config: {},
  fixtures: [planFixture('tron: approve(declared spender, input)', tron)] })
describeProtocolBehaviour('TronIncreaseExact', { type: 'swap2', Protocol: planModule(tronApprove(TRON_ROUTER_HEX, (a) => a, true)) as never, config: {},
  fixtures: [planFixture('tron: increaseAllowance(declared spender, input)', tron)] })

import { describeProtocolBehaviour } from '../../../src/index.js'
import { ME_TRON, TRON_ROUTER, TRON_STRANGER_HEX, TRON_USDT, planFixture, planModule, tronApprove } from './plan-modules.js'

// A Tron call to the declared source token whose calldata approves a spender nobody declared.
const MAX = (1n << 256n) - 1n
const tron = { account: { address: ME_TRON, chain: 'tron:mainnet' }, spender: TRON_ROUTER, sourceToken: TRON_USDT, callTargets: [TRON_ROUTER], decode: () => [ME_TRON] }
describeProtocolBehaviour('TronApproveStranger', { type: 'swap2', Protocol: planModule(tronApprove(TRON_STRANGER_HEX, () => MAX)) as never, config: {},
  fixtures: [planFixture('tron: approve(undeclared spender, max)', tron)] })
describeProtocolBehaviour('TronIncreaseStranger', { type: 'swap2', Protocol: planModule(tronApprove(TRON_STRANGER_HEX, (a) => a, true)) as never, config: {},
  fixtures: [planFixture('tron: increaseAllowance(undeclared spender, input)', tron)] })

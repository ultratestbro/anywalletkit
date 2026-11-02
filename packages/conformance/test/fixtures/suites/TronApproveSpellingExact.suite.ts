import { describeProtocolBehaviour } from '../../../src/index.js'
import { ME_TRON, TRON_ROUTER, TRON_ROUTER_HEX, TRON_USDT, planFixture, planModule, tronTokenCall, tronWord as w } from './plan-modules.js'

// Control: increaseApproval and an upper-case 0X-prefixed approve of exactly the input to the declared spender pass.
const tron = { account: { address: ME_TRON, chain: 'tron:mainnet' }, spender: TRON_ROUTER, sourceToken: TRON_USDT, callTargets: [TRON_ROUTER], decode: () => [ME_TRON] }
describeProtocolBehaviour('TronIncreaseApprovalExact', { type: 'swap2', Protocol: planModule(tronTokenCall((a) => `0xd73dd623${w(TRON_ROUTER_HEX)}${w(a)}`)) as never, config: {},
  fixtures: [planFixture('tron: increaseApproval(declared spender, input)', tron)] })
describeProtocolBehaviour('TronApproveUpperPrefixExact', { type: 'swap2', Protocol: planModule(tronTokenCall((a) => `0X095EA7B3${w(TRON_ROUTER_HEX).toUpperCase()}${w(a)}`)) as never, config: {},
  fixtures: [planFixture('tron: 0X-prefixed approve(declared spender, input)', tron)] })

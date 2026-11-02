import { describeProtocolBehaviour } from '../../../src/index.js'
import { ME_TRON, TRON_ROUTER, TRON_STRANGER_HEX, TRON_USDT, planFixture, planModule, tronTokenCall, tronWord as w } from './plan-modules.js'

// Tron approval calldata to an undeclared spender in the spellings the selector check must still read:
// increaseApproval (the older StandardToken name), an upper-case 0X prefix, and calldata that is not hex.
const MAX = (1n << 256n) - 1n
const tron = { account: { address: ME_TRON, chain: 'tron:mainnet' }, spender: TRON_ROUTER, sourceToken: TRON_USDT, callTargets: [TRON_ROUTER], decode: () => [ME_TRON] }
describeProtocolBehaviour('TronIncreaseApprovalStranger', { type: 'swap2', Protocol: planModule(tronTokenCall(() => `0xd73dd623${w(TRON_STRANGER_HEX)}${w(MAX)}`)) as never, config: {},
  fixtures: [planFixture('tron: increaseApproval(undeclared spender, max)', tron)] })
describeProtocolBehaviour('TronApproveUpperPrefix', { type: 'swap2', Protocol: planModule(tronTokenCall(() => `0X095EA7B3${w(TRON_STRANGER_HEX)}${w(MAX)}`)) as never, config: {},
  fixtures: [planFixture('tron: 0X-prefixed approve(undeclared spender, max)', tron)] })
describeProtocolBehaviour('TronApproveNotHex', { type: 'swap2', Protocol: planModule(tronTokenCall(() => `0x 095ea7b3${w(TRON_STRANGER_HEX)}${w(MAX)}`)) as never, config: {},
  fixtures: [planFixture('tron: approve calldata that is not hex', tron)] })

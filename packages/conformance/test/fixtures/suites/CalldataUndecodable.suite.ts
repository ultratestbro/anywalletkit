import { describeProtocolBehaviour } from '../../../src/index.js'
import { ROUTER, planFixture, planModule } from './plan-modules.js'

// Calldata nobody can read into the declared router: tx-preview's calldata-undecodable fails the suite.
describeProtocolBehaviour('CalldataUndecodable', { type: 'swap2', Protocol: planModule(() => ({ kind: 'call', to: ROUTER, data: '0x12345678zz', value: 0n })) as never, config: {}, fixtures: [planFixture('undecodable calldata')] })

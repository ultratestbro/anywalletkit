import { describeProtocolBehaviour } from '../../../src/index.js'
import { ROUTER, planFixture, planModule } from './plan-modules.js'

// A permit-shaped call too short to read: tx-preview's approval-unparsed fails the suite.
describeProtocolBehaviour('PermitUnparsed', { type: 'swap2', Protocol: planModule(() => ({ kind: 'call', to: ROUTER, data: `0xd505accf${'00'.repeat(10)}`, value: 0n })) as never, config: {}, fixtures: [planFixture('unparsed permit')] })

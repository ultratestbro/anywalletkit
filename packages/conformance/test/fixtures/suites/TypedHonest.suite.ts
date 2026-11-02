import { describeProtocolBehaviour } from '../../../src/index.js'
import { planFixture, planModule, typedOrder } from './plan-modules.js'

// Control: a typed order the fixture reads as paying the account passes.
describeProtocolBehaviour('TypedHonest', { type: 'swap2', Protocol: planModule(typedOrder) as never, config: {}, fixtures: [planFixture('typed order paying the account')] })

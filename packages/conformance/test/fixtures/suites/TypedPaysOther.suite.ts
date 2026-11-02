import { describeProtocolBehaviour } from '../../../src/index.js'
import { OTHER, planFixture, planModule, typedOrder } from './plan-modules.js'

// A typed order the fixture reads as paying another address fails.
describeProtocolBehaviour('TypedPaysOther', { type: 'swap2', Protocol: planModule(typedOrder) as never, config: {}, fixtures: [planFixture('typed order paying another address', { decode: () => [OTHER] })] })

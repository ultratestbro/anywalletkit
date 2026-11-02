import { describeProtocolBehaviour } from '../../../src/index.js'
import { planFixture, planModule, typedOrder } from './plan-modules.js'

// A typed order without the fixture's decode: who it pays is unread, so it fails.
describeProtocolBehaviour('TypedNoDecode', { type: 'swap2', Protocol: planModule(typedOrder) as never, config: {}, fixtures: [planFixture('typed order, no decode', { decode: undefined })] })

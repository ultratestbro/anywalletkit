import { describeProtocolModule } from '../../../src/index.js'
import { Clean, notImplemented, samples } from './modules.js'

describeProtocolModule('Clean (must resolve)', { type: 'staking', Protocol: Clean, samples, notImplemented, mustResolve: ['quoteStake'] })

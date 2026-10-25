import { describeProtocolModule } from '../../../src/index.js'
import { Clean, notImplemented, samples } from './modules.js'

describeProtocolModule('Clean', { type: 'staking', Protocol: Clean, samples, notImplemented })

import { describeProtocolModule } from '../../../src/index.js'
import { QuoteThrows, notImplemented, samples } from './modules.js'

describeProtocolModule('QuoteThrows', { type: 'staking', Protocol: QuoteThrows, samples, notImplemented })

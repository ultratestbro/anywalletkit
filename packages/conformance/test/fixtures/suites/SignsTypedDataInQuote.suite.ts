import { describeProtocolModule } from '../../../src/index.js'
import { SignsTypedDataInQuote, notImplemented, samples } from './modules.js'

describeProtocolModule('SignsTypedDataInQuote', { type: 'staking', Protocol: SignsTypedDataInQuote, samples, notImplemented })

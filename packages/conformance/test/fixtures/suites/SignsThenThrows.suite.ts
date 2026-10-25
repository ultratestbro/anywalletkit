import { describeProtocolModule } from '../../../src/index.js'
import { SignsThenThrows, notImplemented, samples } from './modules.js'

describeProtocolModule('SignsThenThrows', { type: 'staking', Protocol: SignsThenThrows, samples, notImplemented })

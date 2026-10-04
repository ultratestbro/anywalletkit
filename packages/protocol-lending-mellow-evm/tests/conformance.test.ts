import { describeProtocolModule } from '@forgewallet/conformance'
import MellowProtocolEvm from '../index.js'

describeProtocolModule('protocol-lending-mellow-evm', { type: 'lending', Protocol: MellowProtocolEvm as never, config: { preset: 'lido-earn-eth' }, notImplemented: ['borrow', 'repay', 'quoteBorrow', 'quoteRepay'] })

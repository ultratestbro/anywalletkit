import { describeProtocolModule } from '@forgewallet/conformance'
import SsvProtocolEvm from '../index.js'

describeProtocolModule('protocol-staking-ssv-evm', { type: 'staking', Protocol: SsvProtocolEvm as never, config: {} })

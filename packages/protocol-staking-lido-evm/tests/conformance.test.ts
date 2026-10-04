import { describeProtocolModule } from '@forgewallet/conformance'
import LidoProtocolEvm from '../index.js'

describeProtocolModule('protocol-staking-lido-evm', { type: 'staking', Protocol: LidoProtocolEvm as never, config: {} })

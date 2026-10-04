import '../src/buffer-global.js'
import { describeProtocolModule } from '@forgewallet/conformance'
import TonstakersProtocolTon from '../index.js'

describeProtocolModule('protocol-staking-tonstakers-ton', { type: 'staking', Protocol: TonstakersProtocolTon as never, config: {}, unsupported: ['claimWithdrawals', 'quoteClaimWithdrawals'] })

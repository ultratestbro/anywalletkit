import { describeProtocolModule } from '@forgewallet/conformance'
import ApprovalsProtocolEvm from '../index.js'

describeProtocolModule('protocol-approvals-evm', { type: 'approvals', Protocol: ApprovalsProtocolEvm as never, config: {} })

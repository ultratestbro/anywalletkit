import { describeProtocolModule } from '@forgewallet/conformance'
import SplStakePoolProtocolSolana from '../index.js'

describeProtocolModule('protocol-staking-spl-stake-pool-solana', { type: 'staking', Protocol: SplStakePoolProtocolSolana as never, config: {} })

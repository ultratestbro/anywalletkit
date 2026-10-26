import { describeActivitySuite } from '../../../src/index.js'
import { PureActivity, activityFixture } from './modules.js'

describeActivitySuite('PureActivity', { Protocol: PureActivity, fixtures: [activityFixture] })

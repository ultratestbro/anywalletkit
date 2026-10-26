import { describeActivitySuite } from '../../../src/index.js'
import { SignsInDescribe, activityFixture } from './modules.js'

describeActivitySuite('SignsInDescribe', { Protocol: SignsInDescribe, fixtures: [activityFixture] })

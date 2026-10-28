// The upgrade guide's Omniston line must typecheck: omnistonVerifyBuild takes what createOmnistonTonValidators returns.
import { expect, it } from 'vitest'
import { omnistonPins, omnistonVerifyBuild } from '../src/index.js'
import { AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS, createOmnistonTonValidators } from '../src/validators/index.js'
it('the guide sample compiles and builds pins', () => {
  const pins = { ...omnistonPins(AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS), verifyBuild: omnistonVerifyBuild({ ...createOmnistonTonValidators(), integratorAddress: null }) }
  expect(typeof pins.verifyBuild).toBe('function')
  expect(pins.spenders('eip155:1')).toHaveLength(1)
})

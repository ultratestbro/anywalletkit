// node --test scripts/eslint: the rule reports exactly the lines fixtures/cases.ts marks "// flagged".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import tseslint from 'typescript-eslint'
import rule from './no-number-bigint.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, 'fixtures', 'cases.ts')

test('no-number-bigint reports Number() on bigints and nothing else', async () => {
  const eslint = new ESLint({
    cwd: here,
    overrideConfigFile: true,
    overrideConfig: [{
      files: ['**/*.ts'],
      languageOptions: { parser: tseslint.parser, parserOptions: { projectService: { allowDefaultProject: ['fixtures/*.ts'] }, tsconfigRootDir: here } },
      plugins: { anywalletkit: { rules: { 'no-number-bigint': rule } } },
      rules: { 'anywalletkit/no-number-bigint': 'error' },
    }],
  })
  const [result] = await eslint.lintFiles([file])
  const fatal = result.messages.filter((m) => m.fatal)
  assert.deepEqual(fatal, [])
  const expected = readFileSync(file, 'utf8').split('\n').flatMap((line, i) => (line.endsWith('// flagged') ? [i + 1] : []))
  const reported = result.messages.map((m) => m.line)
  assert.deepEqual(reported, expected)
})

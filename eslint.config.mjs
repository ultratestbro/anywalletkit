// Correctness lint for the SDK sources: promises that nobody awaits, and Number() on bigints.
// Style is left to the formatter; these rules find bugs (audit 2026-10-25, finding 16).
import tseslint from 'typescript-eslint'
import noNumberBigint from './scripts/eslint/no-number-bigint.mjs'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts'] },
  {
    files: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.js'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // The JS-only modules (JSDoc types) are not in a tsconfig: type-check them with the default project.
        projectService: { allowDefaultProject: ['packages/*/src/*.js'], maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 32 },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    plugins: { '@typescript-eslint': tseslint.plugin, anywalletkit: { rules: { 'no-number-bigint': noNumberBigint } } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      'anywalletkit/no-number-bigint': 'error',
      'no-debugger': 'error',
      'no-unsafe-finally': 'error',
      'no-dupe-keys': 'error',
      'no-self-compare': 'error',
    },
  },
)

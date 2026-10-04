#!/usr/bin/env node
// Bundle entry.ts for Hermes and run it in the Hermes VM.
// Binary lookup: $HERMES_BIN → hermes-engine-cli (npm) → a React Native SDK
// checkout (react-native/sdks/hermesc/<os>-bin/hermes).
import { build } from 'esbuild'
import { transformAsync } from '@babel/core'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(dirname(here))
const outdir = join(root, 'node_modules', '.cache', 'hermes-smoke')
mkdirSync(outdir, { recursive: true })
const outfile = join(outdir, 'smoke.js')

await build({
  entryPoints: [join(here, 'entry.ts')],
  bundle: true, format: 'iife', platform: 'neutral', target: 'es2020', outfile,

  mainFields: ['react-native', 'module', 'main'], conditions: ['react-native', 'import', 'default'],
  define: { 'process.env.NODE_ENV': '"production"' },
  // @ton/crypto-primitives' react-native build requires expo-crypto (random bytes) at module load and
  // react-native-fast-pbkdf2 for mnemonics — an Expo app has them; the smoke supplies stand-ins.
  // tweetnacl's optional `require('crypto')` is guarded at runtime: leave it unresolved.
  alias: { 'expo-crypto': join(here, 'stubs/expo-crypto.ts'), 'react-native-fast-pbkdf2': join(here, 'stubs/react-native-fast-pbkdf2.ts') },
  external: ['crypto'],
  logLevel: 'warning',
})

// Hermes has no classes / async-await / etc. — Metro lowers them with @react-native/babel-preset.
// Profile 'default' (not 'hermes-stable'): the RN 0.81.5 Hermes binary rejects `class` syntax, so
// classes must be lowered too. Same preset Metro uses, so what runs here is what a RN app really runs.
const babel = await transformAsync(readFileSync(outfile, 'utf8'), {
  filename: outfile, babelrc: false, configFile: false, compact: false, sourceMaps: false,
  presets: [['@react-native/babel-preset', { unstable_transformProfile: 'default', enableBabelRuntime: false }]],
})
writeFileSync(outfile, babel.code)

const RN_VERSION = process.env.RN_VERSION ?? '0.81.5'
const osBin = process.platform === 'darwin' ? 'osx-bin' : process.platform === 'win32' ? 'win64-bin' : 'linux64-bin'

/**
 * The Hermes VM that React Native actually ships (react-native/sdks/hermesc/<os>-bin/hermes).
 * hermes-engine-cli on npm is Hermes 0.12 from 2022 and rejects regex named groups viem uses,
 * so it is only the last resort. Lookup: $HERMES_BIN → react-native in any node_modules →
 * the react-native npm tarball (downloaded once into node_modules/.cache) → hermes-engine-cli.
 */
function findHermes() {
  if (process.env.HERMES_BIN) return process.env.HERMES_BIN
  const require = createRequire(import.meta.url)
  try { const c = join(dirname(require.resolve('react-native/package.json')), 'sdks/hermesc', osBin, 'hermes'); if (existsSync(c)) return c } catch { /* no RN here */ }
  for (const c of [process.env.RN_SDK_HERMES]) if (c && existsSync(c)) return c
  const cached = join(outdir, `rn-${RN_VERSION}`, 'hermes')
  if (existsSync(cached)) return cached
  try {
    console.log(`[hermes] downloading react-native@${RN_VERSION} to extract sdks/hermesc/${osBin}/hermes …`)
    const dest = join(outdir, `rn-${RN_VERSION}`)
    mkdirSync(dest, { recursive: true })
    const pack = spawnSync('npm', ['pack', `react-native@${RN_VERSION}`, '--pack-destination', dest, '--silent'], { encoding: 'utf8', timeout: 600_000 })
    const tgz = pack.stdout.trim().split('\n').pop()
    if (pack.status === 0 && tgz) {
      const tar = spawnSync('tar', ['-xzf', join(dest, tgz), '-C', dest, '--strip-components=4', `package/sdks/hermesc/${osBin}/hermes`], { encoding: 'utf8' })
      if (tar.status === 0 && existsSync(cached)) return cached
    }
  } catch { /* offline */ }
  try {
    const pkgDir = dirname(require.resolve('hermes-engine-cli/package.json'))
    const c = join(pkgDir, osBin, 'hermes')
    if (existsSync(c)) { console.warn('[hermes] WARNING: falling back to hermes-engine-cli 0.12 (2022) — not the engine RN ships'); return c }
  } catch { /* not installed */ }
  return undefined
}

const bin = findHermes()
if (!bin) { console.error('No Hermes binary found. Set HERMES_BIN or install hermes-engine-cli.'); process.exit(2) }
const res = spawnSync(bin, ['-O', '-w', outfile], { encoding: 'utf8', timeout: 300_000 })
const text = (res.stdout ?? '') + (res.stderr ?? '')
const lines = text.split('\n').filter((l) => l.trim() && !/warning:|\^~|^\s*\}\)/.test(l))
console.log(`[hermes ${bin}]`)
console.log(lines.slice(-12).join('\n'))
if (res.status !== 0 || !/HERMES_SMOKE_OK/.test(text)) process.exit(1)

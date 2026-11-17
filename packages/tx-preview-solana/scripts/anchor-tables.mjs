#!/usr/bin/env node
// Turn an Anchor program's IDL into the compact tables `src/decoders/anchor.ts` reads (TYPES, INSTRUCTIONS, EVENTS).
// The IDL comes from the chain — the program's IDL account, `createWithSeed(PDA([], program), "anchor:idl", program)`,
// zlib-compressed JSON after an 8 + 32 + 4 byte header — or from a saved JSON file. Both IDL formats are read: the
// current one (discriminators listed, snake_case names) and the pre-0.30 one (camelCase names, discriminators derived).
//
// Usage:
//   SOLANA_RPC_URL=… node scripts/anchor-tables.mjs <programId>                      print the table block
//   SOLANA_RPC_URL=… node scripts/anchor-tables.mjs <programId> --write <decoder.ts>  replace the block in a decoder
//   node scripts/anchor-tables.mjs <programId> --idl <idl.json> [--write <decoder.ts>] from a saved IDL
//   … --save-idl <idl.json>                                                          also keep the fetched IDL
//
// The block sits between `// <anchor-tables …>` and `// </anchor-tables>`; --write replaces only that, so the
// decoder's hand-written header and exports stay. Refresh the snapshot note in the file's header comment afterwards.
// Regenerate when the program upgrades: Jupiter v6 → src/decoders/jupiter.ts, Kamino Lend → src/decoders/kamino.ts.
import { createAddressWithSeed, createSolanaRpc, getProgramDerivedAddress, address } from '@solana/kit'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const args = process.argv.slice(2)
const program = args[0]
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
if (!program || program.startsWith('--')) {
  console.error('usage: anchor-tables.mjs <programId> [--idl <idl.json>] [--write <decoder.ts>] [--save-idl <idl.json>]')
  process.exit(2)
}

/** The IDL account's address and its JSON. */
async function fetchIdl(programId) {
  const url = process.env.SOLANA_RPC_URL
  if (!url) { console.error('SOLANA_RPC_URL is not set (or pass --idl <file>)'); process.exit(2) }
  const rpc = createSolanaRpc(url)
  const [base] = await getProgramDerivedAddress({ programAddress: address(programId), seeds: [] })
  const idlAccount = await createAddressWithSeed({ baseAddress: base, programAddress: address(programId), seed: 'anchor:idl' })
  const info = await rpc.getAccountInfo(idlAccount, { encoding: 'base64' }).send()
  if (!info.value) { console.error(`no IDL account at ${idlAccount}`); process.exit(1) }
  const data = Buffer.from(info.value.data[0], 'base64')
  // 8 discriminator + 32 authority + 4 length, then the zlib stream.
  const length = data.readUInt32LE(40)
  return { idlAccount, json: inflateSync(data.subarray(44, 44 + length)).toString('utf8') }
}

const idlFile = flag('--idl')
const { idlAccount, json } = idlFile ? { idlAccount: null, json: readFileSync(idlFile, 'utf8') } : await fetchIdl(program)
if (flag('--save-idl')) writeFileSync(flag('--save-idl'), json)
const idl = JSON.parse(json)
const newFormat = 'address' in idl

// ---- names and discriminators

const camel = (s) => {
  if (!s.includes('_')) return s ? s[0].toLowerCase() + s.slice(1) : s
  const [head, ...rest] = s.split('_')
  return head + rest.map((p) => p.slice(0, 1).toUpperCase() + p.slice(1)).join('')
}
const pascal = (s) => { const c = camel(s); return c[0].toUpperCase() + c.slice(1) }
const snake = (name) => name.replace(/(?<!^)(?=[A-Z])/g, '_').toLowerCase()
const sha8 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)
const hex = (bytes) => Buffer.from(bytes).toString('hex')

// ---- types reachable from the instructions and events, in first-use order

const types = new Map(idl.types.map((t) => [t.name, t.type]))
const defName = (t) => (typeof t.defined === 'object' ? t.defined.name : t.defined)
const isField = (f) => f && typeof f === 'object' && 'name' in f && 'type' in f
const used = []
function need(name) {
  if (used.includes(name)) return
  if (!types.has(name)) throw new Error(`IDL type ${name} is missing`)
  used.push(name)
  walkDef(types.get(name))
}
function walk(t) {
  if (typeof t === 'string') return
  if ('defined' in t) return need(defName(t))
  for (const k of ['vec', 'option', 'coption']) if (k in t) return walk(t[k])
  if ('array' in t) return walk(t.array[0])
}
function walkDef(def) {
  if (def.kind === 'struct') for (const f of def.fields ?? []) walk(isField(f) ? f.type : f)
  else for (const v of def.variants) for (const f of v.fields ?? []) walk(isField(f) ? f.type : f)
}

// ---- TypeScript literals

const PRIMITIVES = new Set(['u8', 'u16', 'u32', 'u64', 'u128', 'i8', 'i16', 'i32', 'i64', 'i128', 'bool', 'bytes', 'string'])
function ty(t) {
  if (typeof t === 'string') {
    if (t === 'pubkey' || t === 'publicKey') return "'pubkey'"
    if (!PRIMITIVES.has(t)) throw new Error(`unsupported type ${t}`)
    return `'${t}'`
  }
  if ('defined' in t) return `{ def: '${defName(t)}' }`
  if ('vec' in t) return `{ vec: ${ty(t.vec)} }`
  if ('option' in t) return `{ option: ${ty(t.option)} }`
  if ('array' in t) return `{ array: ${ty(t.array[0])}, len: ${t.array[1]} }`
  throw new Error(`unsupported type ${JSON.stringify(t)}`)
}
function fields(fs) {
  // Tuple variants (`Foo(u64)`) get `value` / `value0`, `value1`…
  const one = (f, i) => (isField(f) ? `['${camel(f.name)}', ${ty(f.type)}]` : `['${fs.length === 1 ? 'value' : `value${i}`}', ${ty(f)}]`)
  return '[' + fs.map(one).join(', ') + ']'
}
function typeDef(name, def) {
  if (def.kind === 'struct') return [`  ${name}: { struct: ${fields(def.fields ?? [])} },`]
  const units = def.variants.map((v) => `['${v.name}']`)
  if (def.variants.every((v) => !v.fields?.length)) return [`  ${name}: { variants: [${units.join(', ')}] },`]
  const rows = def.variants.map((v) => (v.fields?.length ? `    ['${v.name}', ${fields(v.fields)}],` : `    ['${v.name}'],`))
  return [`  ${name}: { variants: [`, ...rows, '  ] },']
}

/** Nested account groups flattened in order; a leaf name two groups share gets its group's stem as a prefix. */
function flatAccounts(accounts) {
  const leaves = []
  const rec = (list, group) => { for (const a of list) a.accounts ? rec(a.accounts, a.name) : leaves.push([camel(a.name), group]) }
  rec(accounts, null)
  const count = new Map()
  for (const [n] of leaves) count.set(n, (count.get(n) ?? 0) + 1)
  const out = leaves.map(([n, g]) => (count.get(n) > 1 && g ? g.replace(/Accounts$/, '') + n[0].toUpperCase() + n.slice(1) : n))
  if (new Set(out).size !== out.length) throw new Error(`account names collide: ${out.join(', ')}`)
  return out
}

const notes = []
const ixRows = idl.instructions.map((ix) => {
  let disc = sha8(`global:${newFormat ? ix.name : snake(ix.name)}`)
  if (newFormat && hex(ix.discriminator) !== disc) {
    notes.push(`${pascal(ix.name)} sets its discriminator explicitly: ${hex(ix.discriminator)} (sha256 would give ${disc})`)
    disc = hex(ix.discriminator)
  }
  for (const a of ix.args) walk(a.type)
  return `  ['${disc}', '${pascal(ix.name)}', ${fields(ix.args)}, [${flatAccounts(ix.accounts).map((a) => `'${a}'`).join(', ')}]],`
})
const evRows = (idl.events ?? []).map((ev) => {
  let disc = sha8(`event:${ev.name}`)
  let fs = ev.fields
  if (newFormat) {
    if (hex(ev.discriminator) !== disc) {
      notes.push(`event ${ev.name} sets its discriminator explicitly: ${hex(ev.discriminator)}`)
      disc = hex(ev.discriminator)
    }
    const def = types.get(ev.name)
    walkDef(def)
    fs = def.fields
  } else for (const f of fs) walk(f.type)
  return `  ['${disc}', '${ev.name}', ${fields(fs)}],`
})

// ---- wrapping at 140 columns

const W = 140
function splitTop(s) {
  const items = []
  let depth = 0, cur = '', quoted = false
  for (const ch of s) {
    if (ch === "'") quoted = !quoted
    if (!quoted) {
      if (ch === '[' || ch === '{') depth++
      else if (ch === ']' || ch === '}') depth--
      else if (ch === ',' && depth === 0) { items.push(cur.trim()); cur = ''; continue }
    }
    cur += ch
  }
  if (cur.trim()) items.push(cur.trim())
  return items
}
function fill(items, indent) {
  const lines = []
  let cur = indent
  items.forEach((item, i) => {
    const piece = item + ','
    const next = cur.trim() ? `${cur} ${piece}` : cur + piece
    if (next.length > W && cur.trim()) { lines.push(cur.trimEnd()); cur = indent + piece } else cur = next
  })
  lines.push(cur)
  return lines
}
function wrap(line) {
  if (line.length <= W) return [line]
  let m
  if ((m = /^( {2}\w+: \{ (?:variants|struct): \[)(.*)\] \},$/.exec(line))) return [m[1], ...fill(splitTop(m[2]), '    '), '  ] },']
  if ((m = /^ {4}\[('[^']+'), \[(.*)\]\],$/.exec(line))) return [`    [${m[1]}, [`, ...fill(splitTop(m[2]), '      '), '    ]],']
  if (line.startsWith("  ['") && line.endsWith('],')) {
    const parts = splitTop(line.slice(3, -2))
    const out = []
    const first = `  [${parts[0]}, ${parts[1]}, ${parts[2]},`
    if (first.length <= W) out.push(first)
    else out.push(`  [${parts[0]}, ${parts[1]}, [`, ...fill(splitTop(parts[2].slice(1, -1)), '    '), parts.length > 3 ? '  ],' : '  ]],')
    if (parts.length > 3) {
      const one = `    ${parts[3]}],`
      if (one.length <= W) out.push(one)
      else out.push('    [', ...fill(splitTop(parts[3].slice(1, -1)), '      '), '    ]],')
    } else if (first.length <= W) out[out.length - 1] = out[out.length - 1].slice(0, -1) + '],'
    return out
  }
  return [line]
}

// ---- the block

const today = new Date().toISOString().slice(0, 10)
const source = idlAccount ? `IDL account ${idlAccount}` : `saved IDL ${idlFile.split('/').pop()}`
const version = idl.metadata?.version ?? idl.version
const lines = [
  `// <anchor-tables program=${program} idl=${idl.metadata?.name ?? idl.name}@${version}>`,
  `// Generated ${today} by scripts/anchor-tables.mjs from the ${source};`,
  '// regenerate instead of editing by hand.',
  ...notes.map((n) => `// ${n}`),
  'const TYPES: AnchorTypes = {',
  ...used.flatMap((n) => typeDef(n, types.get(n))).flatMap(wrap),
  '}',
  '',
  'const INSTRUCTIONS: readonly AnchorInstruction[] = [',
  ...ixRows.flatMap(wrap),
  ']',
  '',
  'const EVENTS: readonly AnchorEvent[] = [',
  ...evRows.flatMap(wrap),
  ']',
  '// </anchor-tables>',
]
const block = lines.join('\n')

const target = flag('--write')
if (target) {
  const text = readFileSync(target, 'utf8')
  const start = text.indexOf('// <anchor-tables')
  const endMark = '// </anchor-tables>'
  const end = text.indexOf(endMark)
  if (start < 0 || end < 0) { console.error(`${target} has no // <anchor-tables> … // </anchor-tables> block`); process.exit(1) }
  writeFileSync(target, text.slice(0, start) + block + text.slice(end + endMark.length))
  console.error(`${target}: ${idl.instructions.length} instructions, ${evRows.length} events, ${used.length} types (${source})`)
} else {
  console.log(block)
  console.error(`${idl.instructions.length} instructions, ${evRows.length} events, ${used.length} types (${source})`)
}

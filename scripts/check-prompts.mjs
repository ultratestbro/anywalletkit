#!/usr/bin/env node
/**
 * The cookbook prompts live twice: prompts/NN-name.md (raw, copy-paste) and the
 * docs page apps/docs/src/content/docs/build-with-ai/name.md, inside its
 * ```text block. This fails when the two drift apart. Run by `pnpm docs:build`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pages = join(root, 'apps/docs/src/content/docs/build-with-ai')
let failed = 0
for (const file of readdirSync(join(root, 'prompts')).filter((f) => /^\d\d-.+\.md$/.test(f)).sort()) {
  const prompt = readFileSync(join(root, 'prompts', file), 'utf8').trim()
  const slug = file.replace(/^\d\d-/, '')
  let page
  try {
    page = readFileSync(join(pages, slug), 'utf8')
  } catch {
    console.error(`check-prompts: no docs page build-with-ai/${slug} for prompts/${file}`)
    failed++
    continue
  }
  const block = /```text[^\n]*\n([\s\S]*?)\n```/.exec(page)?.[1]?.trim()
  if (block !== prompt) {
    console.error(`check-prompts: build-with-ai/${slug} does not carry prompts/${file} verbatim`)
    failed++
  }
}
if (failed) process.exit(1)
console.log('check-prompts: ok')

/**
 * What to tell the user next to a name that normalizes fine but still deserves
 * a second look: labels mixing scripts, labels made only of Cyrillic letters
 * that look Latin, punycode labels. Explicit code-point ranges, not
 * `\p{Script=…}` — Hermes (React Native) has no Unicode property escapes.
 */
import type { NameWarning } from '@anywalletkit/core'

const SCRIPTS: Array<[string, RegExp]> = [
  ['Latin', /[A-Za-zÀ-ɏḀ-ỿ]/],
  ['Cyrillic', /[Ѐ-ӿԀ-ԯ]/],
  ['Greek', /[Ͱ-Ͽἀ-῿]/],
  ['Armenian', /[԰-֏]/],
  ['Hebrew', /[֐-׿]/],
  ['Arabic', /[؀-ۿݐ-ݿ]/],
]
/** Cyrillic letters that render like Latin ones in common fonts (а е о р с у х і ј ѕ һ ԁ ԛ ԝ ѵ ԛ), plus digits and hyphen. */
const LOOKALIKE = /^[аеорсухіјѕһԁԛԝѵү0-9-]+$/

export function warningsFor(name: string): NameWarning[] {
  const out: NameWarning[] = []
  for (const label of name.split('.')) {
    if (!label) continue
    if (label.startsWith('xn--')) {
      out.push({ code: 'punycode', label, message: `"${label}" is a punycode label — the real characters may not be what they look like.` })
      continue
    }
    const scripts = SCRIPTS.filter(([, re]) => re.test(label)).map(([n]) => n)
    if (scripts.length > 1) {
      out.push({ code: 'mixed-script', label, message: `"${label}" mixes ${scripts.join(' and ')} letters — a common trick to imitate another name.` })
    } else if (scripts[0] === 'Cyrillic' && LOOKALIKE.test(label)) {
      out.push({ code: 'confusable', label, message: `"${label}" is written in Cyrillic letters that look like Latin ones.` })
    }
  }
  return out
}

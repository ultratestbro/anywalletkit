/**
 * What to tell the user next to a name that normalizes fine but still deserves
 * a second look: labels mixing scripts (`pаypal.eth` with a Cyrillic а), labels
 * made only of Cyrillic letters that look Latin, punycode labels.
 */
import type { NameWarning } from '@forgewallet/core'

const SCRIPTS: Array<[string, RegExp]> = [
  ['Latin', /\p{Script=Latin}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Greek', /\p{Script=Greek}/u],
  ['Armenian', /\p{Script=Armenian}/u],
  ['Hebrew', /\p{Script=Hebrew}/u],
  ['Arabic', /\p{Script=Arabic}/u],
]
/** Cyrillic letters that render like Latin ones in common fonts. */
const LOOKALIKE = /^[аеоруსაіјѕһԁԛԝсѕіјԁԛԝһорухаесxх0-9-]+$/u

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

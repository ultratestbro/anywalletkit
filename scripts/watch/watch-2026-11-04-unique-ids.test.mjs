// Final review 2026-11-04: watch state is keyed by module + source id, so a duplicated id makes both
// sources look re-pointed on every run and real upstream changes at either target go unreported.
import {test} from "node:test";
import assert from "node:assert/strict";
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("every watch source id is unique within its module", () => {
  const ids = new Map();
  for (const d of readdirSync(resolve(ROOT, "packages"))) {
    const f = resolve(ROOT, "packages", d, "watch.json");
    if (!existsSync(f)) continue;
    const m = JSON.parse(readFileSync(f, "utf8"));
    const seen = ids.get(m.module) ?? new Set(); ids.set(m.module, seen);
    for (const s of m.sources ?? []) {
      assert.ok(s.id, `${d}/watch.json: a source has no id`);
      assert.ok(!seen.has(s.id), `${m.module}: source id "${s.id}" appears twice`);
      seen.add(s.id);
    }
  }
  assert.ok(ids.size > 0);
});

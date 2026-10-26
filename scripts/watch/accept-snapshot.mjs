#!/usr/bin/env node
// Commit job of .github/workflows/watch.yml (audit 2026-10-25 round 3, L23): the snapshot artifact
// was written by the watch job, which runs third-party code (npm deps, the modules' verify-live).
// Only data files may come from it: what the watch looks at (addresses.json, routes.json) is
// reviewed in git and restored from the checkout; links, other paths and oversized files fail the
// job before anything is committed.
//
//   node scripts/watch/accept-snapshot.mjs [dir]          (dir defaults to watch)
//   node --test scripts/watch/accept-snapshot.test.mjs
import {execFileSync} from "node:child_process";
import {lstatSync, readdirSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

export const CONFIG_FILES = ["addresses.json", "routes.json"];
const DATA = /^(state|canary|diff|digest|routes)\/[A-Za-z0-9._-]+\.(json|md)$/;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Paths under `root` the commit must not take (empty = all good). Config files are skipped: they are restored. */
export function rejectedPaths(root) {
  const bad = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(root, r));
      if (st.isSymbolicLink()) bad.push(`${r} (link)`);
      else if (st.isDirectory()) walk(r);
      else if (!st.isFile()) bad.push(`${r} (not a regular file)`);
      else if (CONFIG_FILES.includes(r)) continue;
      else if (!DATA.test(r)) bad.push(r);
      else if (st.size > MAX_FILE_BYTES) bad.push(`${r} (${st.size} bytes)`);
    }
  };
  walk("");
  return bad;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? "watch";
  // Restore first: a link or a rewritten config in the artifact is replaced by the reviewed file.
  execFileSync("git", ["checkout", "--", ...CONFIG_FILES.map((f) => `${root}/${f}`)], {stdio: "inherit"});
  const bad = rejectedPaths(root);
  if (bad.length) {
    console.error(`The snapshot artifact holds what a snapshot never does; nothing is committed:\n  ${bad.join("\n  ")}`);
    process.exit(1);
  }
  console.log("snapshot accepted: data files only, configs from git");
}

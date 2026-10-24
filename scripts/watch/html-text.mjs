// Visible text of a third-party HTML page, in linear time (scan 2026-10-23 F12).
// Same output as the regex chain it replaces —
//   <script…</script>, <style…</style>, <(nav|header|footer)…</same>, <!--…-->, <…> → " ",
//   &nbsp; &#160; &amp; &lt; &gt; decoded, whitespace squashed —
// but every pass is a forward scan: no lazy [\s\S]*? that re-scans to the end from each
// unclosed opener (quadratic on a hostile page of repeated `<script` with no closer).

/** Max page size read from a source: real docs pages are well under 1 MB. */
export const MAX_PAGE_BYTES = 4 * 1024 * 1024;

/** Read a fetch Response body up to `max` bytes; larger pages are refused, not parsed. */
export async function readCapped(response, max = MAX_PAGE_BYTES) {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > max) throw new Error(`page too large (${declared} bytes)`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new Error(`page too large (> ${max} bytes)`); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

/**
 * Replace every `open … close` block (case-insensitive, minimal match) with " ".
 * Opens with no close after them are left as they are, exactly like the lazy regex.
 */
function stripBlocks(h, opens, closeOf) {
  const lower = h.toLowerCase();
  // An opener after the last closer of its kind can never match: no forward search for it.
  const lastClose = new Map(opens.map((o) => [o, lower.lastIndexOf(closeOf(o))]));
  let out = "";
  let pos = 0;
  let from = 0;
  for (;;) {
    let best = -1;
    let which = null;
    for (const o of opens) {
      if (lastClose.get(o) < from) continue;
      const i = lower.indexOf(o, from);
      if (i >= 0 && (best < 0 || i < best)) { best = i; which = o; }
    }
    if (best < 0) break;
    const close = closeOf(which);
    const end = lower.indexOf(close, best + which.length);
    if (end < 0) { from = best + 1; continue; }
    out += h.slice(pos, best) + " ";
    pos = from = end + close.length;
  }
  return out + h.slice(pos);
}

/** `<[^>]+>` → " ", linear: a `<` with no `>` after it is plain text. */
function stripTags(h) {
  const lastGt = h.lastIndexOf(">");
  let out = "";
  let pos = 0;
  let from = 0;
  for (;;) {
    const lt = h.indexOf("<", from);
    if (lt < 0 || lt > lastGt) break;
    const gt = h.indexOf(">", lt + 1);
    if (gt === lt + 1) { from = lt + 1; continue; } // "<>" is not a tag ([^>]+ needs one char)
    out += h.slice(pos, lt) + " ";
    pos = from = gt + 1;
  }
  return out + h.slice(pos);
}

export function visibleText(html, between) {
  let h = html;
  if (between?.length === 2) {
    const a = h.indexOf(between[0]); const b = a >= 0 ? h.indexOf(between[1], a) : -1;
    if (a >= 0 && b > a) h = h.slice(a, b);
  }
  h = stripBlocks(h, ["<script"], () => "</script>");
  h = stripBlocks(h, ["<style"], () => "</style>");
  h = stripBlocks(h, ["<nav", "<header", "<footer"], (o) => `</${o.slice(1)}>`);
  h = stripBlocks(h, ["<!--"], () => "-->");
  h = stripTags(h);
  return h.replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

/**
 * The first `limit` `<open\b … </open>` blocks of a feed, in order, case-sensitive —
 * what `[...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)].slice(0, limit)` returned,
 * without re-scanning to the end from each unclosed opener. Each block is capped at
 * `maxBlock` chars before the per-item regexes see it.
 */
export function firstBlocks(text, names, limit, maxBlock = 64 * 1024) {
  const lastClose = new Map(names.map((n) => [n, text.lastIndexOf(`</${n}>`)]));
  const out = [];
  let from = 0;
  while (out.length < limit) {
    let best = -1;
    let which = null;
    for (const n of names) {
      if (lastClose.get(n) < from) continue;
      let i = text.indexOf(`<${n}`, from);
      // \b after the name: `<items` is not `<item`.
      while (i >= 0 && /\w/.test(text[i + n.length + 1] ?? "")) i = text.indexOf(`<${n}`, i + 1);
      if (i >= 0 && (best < 0 || i < best)) { best = i; which = n; }
    }
    if (best < 0) break;
    const close = `</${which}>`;
    const end = text.indexOf(close, best + which.length + 1);
    if (end < 0) { from = best + 1; continue; }
    const block = text.slice(best, end + close.length);
    out.push(block.length > maxBlock ? block.slice(0, maxBlock) : block);
    from = end + close.length;
  }
  return out;
}

/** HTML for the Telegram digest — quotes too, because a link lands inside href="…" (scan 2026-10-23 F13). */
export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Only https links to github.com or the source's own host reach the digest — upstream data names the rest (scan F13). */
export function safeLink(url, source) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const own = source?.url ? new URL(source.url).host : null;
    return u.protocol === "https:" && (u.host === "github.com" || u.host === own) ? u.href : null;
  } catch {
    return null;
  }
}

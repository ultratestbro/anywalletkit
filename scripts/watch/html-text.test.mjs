// node --test scripts/watch/html-text.test.mjs — security scan 2026-10-23 F12/F13.
import {test} from "node:test";
import assert from "node:assert/strict";
import {esc, firstBlocks, safeLink, visibleText} from "./html-text.mjs";

const legacy = (h) => h.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<(nav|header|footer)[\s\S]*?<\/\1>/gi, " ")
  .replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

test("visibleText = the old regex chain (so stored page hashes do not move)", () => {
  for (const c of ["<SCRIPT>a</script>b", "<nav>x<header>y</nav>z</header>w", "<script>x<style>y</style>z", "a<b<c>d", "x<>y>z", "<!-- a -- > b --> c",
    "<footer>q</FOOTER>r", "<navy>1</nav>2", "t&amp;lt;", "<style>s</style><style>t", "<p>Hi&nbsp;there</p><header>menu</header><main>body</main>"]) {
    assert.equal(visibleText(c), legacy(c), c);
  }
});

test("F12: hostile pages are linear (the old chain took minutes)", () => {
  for (const hostile of ["<script".repeat(400_000), "<!--".repeat(500_000), "<nav".repeat(400_000), "<".repeat(2_000_000)]) {
    const t = performance.now();
    visibleText(hostile);
    assert.ok(performance.now() - t < 500, `took ${performance.now() - t} ms`);
  }
  const t = performance.now();
  firstBlocks("<item".repeat(500_000), ["item", "entry"], 5);
  assert.ok(performance.now() - t < 500);
});

test("firstBlocks = matchAll(/<(item|entry)\\b[\\s\\S]*?<\\/\\1>/g).slice(0, 5)", () => {
  for (const c of ["<items>x</items><item>a</item>", "<entry>1</entry><item>2</item>", "<item>open<entry>e</entry>", "<itemx></item><item>y</item>", "<item>1</item><item>2</item><item>3</item><item>4</item><item>5</item><item>6</item>"]) {
    assert.deepEqual(firstBlocks(c, ["item", "entry"], 5), [...c.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)].slice(0, 5).map((m) => m[0]), c);
  }
});

test("F13: a tag name cannot break out of href, and only trusted hosts are linked", () => {
  const tag = 'v9"x onclick="y';
  const html = `<a href="${esc(safeLink(`https://github.com/Uniswap/v3-core/releases/tag/${encodeURIComponent(tag)}`, {}))}">x</a>`;
  assert.ok(!html.includes('"x onclick'));
  assert.equal(esc('a"b<c>&'), "a&quot;b&lt;c&gt;&amp;");
  assert.equal(safeLink("javascript:alert(1)", {}), null);
  assert.equal(safeLink("https://evil.example/x", {url: "https://docs.lido.fi/a"}), null);
  assert.equal(safeLink("https://docs.lido.fi/b", {url: "https://docs.lido.fi/a"}), "https://docs.lido.fi/b");
  assert.equal(safeLink("http://github.com/x", {}), null);
});

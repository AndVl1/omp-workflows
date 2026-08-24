import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdownDocumentHtml } from "../src/report/markdown.js";

test("markdown renderer emits real GFM semantics in a self-contained document", () => {
  const source = [
    "# Product PRD",
    "",
    "## Решение",
    "",
    "- first",
    "- [x] shipped",
    "",
    "### Details",
    "",
    "```ts",
    "const result = 1 < 2;",
    "```",
    "",
    "| Name | Status |",
    "| :--- | ---: |",
    "| Продукт | ready |",
    "",
    "See [the next section](#details) and [the guide](./guide.md).",
  ].join("\n");
  const html = renderMarkdownDocumentHtml(source, { title: "Product PRD" });

  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes('<title>Product PRD</title>'));
  assert.ok(html.includes("Решение"));
  assert.ok(html.includes("<ul>"));
  assert.ok(html.includes('type="checkbox"'));
  assert.ok(html.includes('<pre><code class="language-ts">'));
  assert.ok(html.includes("&lt;"), "code text is escaped");
  assert.ok(html.includes("<table>"));
  assert.ok(html.includes("Продукт"));
  assert.ok(!html.includes("<link"));
  assert.ok(!html.includes("<script src"));
  assert.ok(!html.includes("<img src"));
  assert.ok(!html.includes("fetch("));
  assert.ok(!html.includes("url()"));
  assert.equal(html, renderMarkdownDocumentHtml(source, { title: "Product PRD" }));
});

test("markdown headings receive deterministic unique IDs, TOC links and section navigation", () => {
  const source = "# Title\n\n## Same!\n\n### Nested\n\n## Same?\n\n## !!!\n\n## Привет мир\n\n## Same!";
  const html = renderMarkdownDocumentHtml(source);
  const ids = [...html.matchAll(/<h[1-6][^>]* id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, ["title", "same", "nested", "same-2", "section", "привет-мир", "same-3"]);

  for (const id of ids) {
    assert.ok(html.includes(`href="#${id}"`), `TOC or heading anchor resolves #${id}`);
  }
  const navigation = html.match(/<nav class="section-navigation"[\s\S]*?<\/nav>/g) ?? [];
  assert.equal(navigation.length, 5);
  assert.ok(navigation[0]?.includes('class="nav-disabled"'), "first section has no broken Previous link");
  assert.ok(navigation.at(-1)?.includes('class="nav-disabled"'), "last section has no broken Next link");
  assert.ok(navigation[1]?.includes('href="#same"') && navigation[1]?.includes('href="#section"'));
});

test("markdown renderer escapes raw HTML and rejects unsafe links/images", () => {
  const html = renderMarkdownDocumentHtml([
    "## Security",
    "",
    "<script>alert(1)</script>",
    "",
    "<img src=x onerror=alert(2)>",
    "",
    "<style>.x{display:none}</style>",
    "",
    "[javascript](javascript:alert(3))",
    "[data](data:text/html,boom)",
    "[vbscript](vbscript:msgbox(1))",
    "[file](file:///etc/passwd)",
    "[broken](://not-a-url)",
    "[https](https://example.test/path)",
    "[mailto](mailto:team@example.test)",
    "[fragment](#security)",
    "[relative](docs/readme.md)",
    "![secret](https://example.test/secret.png)",
  ].join("\n"));

  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(2)&gt;"));
  assert.ok(html.includes("&lt;style&gt;"));
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('href="data:'));
  assert.ok(!html.includes('href="vbscript:'));
  assert.ok(!html.includes('href="file:'));
  assert.ok(!html.includes('href="://'));
  assert.ok(html.includes('href="https://example.test/path"'));
  assert.ok(html.includes('href="mailto:team@example.test"'));
  assert.ok(html.includes('href="#security"'));
  assert.ok(html.includes('href="docs/readme.md"'));
  assert.ok(html.includes("[Image: secret]"));
  assert.ok(!html.includes("<img"));
});

test("markdown renderer supports explicit empty and disabled-navigation states", () => {
  const empty = renderMarkdownDocumentHtml("");
  assert.ok(empty.includes('class="markdown-empty"'));
  assert.ok(empty.includes("This Markdown document is empty."));
  assert.ok(!empty.includes('class="markdown-toc"'));

  const disabled = renderMarkdownDocumentHtml("# Title\n\n## Section", { toc: false, navigation: false });
  assert.ok(!disabled.includes('class="markdown-toc"'));
  assert.ok(!disabled.includes('class="section-navigation"'));
  assert.ok(disabled.includes('<h2 id="section"'));
});

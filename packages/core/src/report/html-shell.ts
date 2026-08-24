/**
 * Shared primitives for self-contained, file://-openable HTML documents.
 *
 * Renderers provide only trusted, internal CSS and JavaScript constants. All
 * user/state-derived shell values are escaped here so report and Markdown
 * viewers keep one security and offline contract.
 */

/** HTML-escape a value for a text node or double-quoted attribute. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serialize a JSON payload for placement inside a script data island.
 *
 * A literal `<` could otherwise begin `</script>` inside a JSON string. The
 * replacement remains valid JSON and JSON.parse restores the original value.
 */
export function serializeJsonIsland(value: unknown): string {
  return (JSON.stringify(value) ?? "null")
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Reset and typography shared by every offline viewer. */
export const OFFLINE_BASE_CSS = `
:root {
  --bg: #f5f6f8;
  --card: #ffffff;
  --ink: #1c2330;
  --muted: #667085;
  --line: #e4e7ec;
  --accent: #2f6fed;
  --ok: #12b76a;
  --warn: #b54708;
  --err: #d92d20;
  --amber: #b54708;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--ink);
}
`;

export interface OfflineHtmlOptions {
  title: string;
  body: string;
  css: string;
  lang?: string;
  dataIsland?: { id: string; value: unknown };
  /** Inline script body, or a complete internal `<script>…</script>` element. */
  script?: string;
}

/**
 * Render a complete self-contained HTML document.
 *
 * `css` and `script` are supplied by trusted renderers and never contain user
 * Markdown. Shell-provided title, language, island id and JSON are escaped.
 */
export function renderOfflineHtml(options: OfflineHtmlOptions): string {
  const lang = escapeHtml(options.lang ?? "en");
  const title = escapeHtml(options.title);
  const island = options.dataIsland
    ? `<script id="${escapeHtml(options.dataIsland.id)}" type="application/json">${serializeJsonIsland(options.dataIsland.value)}</script>`
    : "";
  const script = options.script
    ? /^\s*<script(?:\s|>)/i.test(options.script)
      ? options.script
      : `<script>${options.script}</script>`
    : "";

  return [
    "<!doctype html>",
    `<html lang="${lang}">`,
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${title}</title>`,
    `  <style>${options.css}</style>`,
    "</head>",
    "<body>",
    options.body,
    island,
    script,
    "</body>",
    "</html>",
  ].join("\n");
}

import { marked, type Token, type Tokens } from "marked";
import { escapeHtml, OFFLINE_BASE_CSS, renderOfflineHtml } from "./html-shell.js";

export interface MarkdownDocumentOptions {
  /** Escaped document title; defaults to `Markdown document`. */
  title?: string;
  /** HTML language attribute; defaults to `en`. */
  lang?: string;
  /** Emit the generated table of contents; defaults to `true`. */
  toc?: boolean;
  /** Emit Previous/Next links for level-2 sections; defaults to `true`. */
  navigation?: boolean;
}

interface HeadingInfo {
  token: Tokens.Heading;
  id: string;
  label: string;
}

interface TocNode {
  heading: HeadingInfo;
  children: TocNode[];
}

interface NavigationInfo {
  previous: HeadingInfo | undefined;
  next: HeadingInfo | undefined;
}

const MARKDOWN_CSS = `${OFFLINE_BASE_CSS}
.markdown-document {
  min-height: 100vh;
  padding: 28px 18px 72px;
}
.markdown-container {
  max-width: 980px;
  margin: 0 auto;
}
.markdown-toc {
  margin: 0 0 18px;
  padding: 14px 18px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
}
.markdown-toc h2 {
  margin: 0 0 8px;
  border: 0;
  padding: 0;
  font-size: 15px;
}
.markdown-toc ul {
  margin: 0;
  padding-left: 20px;
}
.markdown-toc li {
  margin: 3px 0;
}
.markdown-toc a,
.markdown-body a {
  color: var(--accent);
  overflow-wrap: anywhere;
}
.markdown-body {
  min-width: 0;
  padding: 24px 28px 32px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
  overflow-wrap: anywhere;
}
.markdown-body > :first-child { margin-top: 0; }
.markdown-body > :last-child { margin-bottom: 0; }
.markdown-body h1,
.markdown-body h2,
.markdown-body h3,
.markdown-body h4,
.markdown-body h5,
.markdown-body h6 {
  scroll-margin-top: 16px;
  line-height: 1.25;
}
.markdown-body h1 { font-size: 28px; }
.markdown-body h2 {
  margin-top: 30px;
  padding-bottom: 7px;
  border-bottom: 1px solid var(--line);
  font-size: 21px;
}
.markdown-body h3 { margin-top: 24px; font-size: 17px; }
.markdown-body h4,
.markdown-body h5,
.markdown-body h6 { margin-top: 20px; font-size: 15px; }
.heading-anchor {
  color: inherit;
  text-decoration: none;
}
.heading-anchor:hover { text-decoration: underline; text-decoration-thickness: 1px; }
.markdown-body h1.hash-target,
.markdown-body h2.hash-target,
.markdown-body h3.hash-target,
.markdown-body h4.hash-target,
.markdown-body h5.hash-target,
.markdown-body h6.hash-target {
  background: #fff8db;
  outline: 2px solid #f3c34d;
  outline-offset: 3px;
  border-radius: 4px;
}
.section-navigation {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: -2px 0 18px;
  color: var(--muted);
  font-size: 12px;
}
.section-navigation a,
.section-navigation .nav-disabled {
  display: inline-block;
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  text-decoration: none;
}
.section-navigation .nav-disabled {
  color: var(--muted);
  background: #f8fafc;
}
.markdown-body p,
.markdown-body ul,
.markdown-body ol,
.markdown-body blockquote,
.markdown-body pre,
.markdown-body table,
.markdown-body hr { margin: 12px 0; }
.markdown-body blockquote {
  margin-left: 0;
  padding: 2px 16px;
  border-left: 4px solid var(--line);
  color: var(--muted);
}
.markdown-body ul,
.markdown-body ol { padding-left: 28px; }
.markdown-body li + li { margin-top: 4px; }
.markdown-body li > input[type="checkbox"] { margin: 0 6px 0 0; accent-color: var(--accent); }
.markdown-body pre {
  max-width: 100%;
  padding: 12px 14px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: #0f172a;
  color: #e2e8f0;
  font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre;
}
.markdown-body code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.markdown-body :not(pre) > code {
  padding: 1px 4px;
  border-radius: 4px;
  background: #f2f4f7;
  color: #344054;
}
.markdown-body table {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
}
.markdown-body th,
.markdown-body td {
  min-width: 96px;
  padding: 7px 10px;
  border: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
}
.markdown-body th { background: #f8fafc; font-weight: 700; }
.markdown-body hr { border: 0; border-top: 1px solid var(--line); }
.markdown-body img { max-width: 100%; }
.markdown-image-alt {
  color: var(--muted);
  font-style: italic;
}
.markdown-empty {
  margin: 0;
  color: var(--muted);
  font-style: italic;
}
.markdown-body a:focus-visible,
.markdown-toc a:focus-visible,
.section-navigation a:focus-visible,
.heading-anchor:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 3px;
}
@media (max-width: 640px) {
  .markdown-document { padding: 14px 10px 44px; }
  .markdown-body { padding: 18px 16px 24px; }
}
@media (prefers-reduced-motion: reduce) {
  .markdown-body h1,
  .markdown-body h2,
  .markdown-body h3,
  .markdown-body h4,
  .markdown-body h5,
  .markdown-body h6 { scroll-margin-top: 0; }
}
`;

const MARKDOWN_SCRIPT = `<script>
(function () {
  "use strict";
  var active = null;
  function highlightHash() {
    if (active) active.classList.remove("hash-target");
    active = null;
    var raw = window.location.hash.slice(1);
    if (!raw) return;
    var id;
    try { id = decodeURIComponent(raw); } catch (e) { return; }
    var target = document.getElementById(id);
    if (!target) return;
    target.classList.add("hash-target");
    active = target;
  }
  document.querySelectorAll('a[href^="#"]').forEach(function (link) {
    link.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        link.click();
      }
    });
  });
  window.addEventListener("hashchange", highlightHash);
  highlightHash();
})();
</script>`;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SCHEME = /^([a-z][a-z\d+.-]*):/i;

/**
 * Permit navigation-only links without allowing a script-capable or malformed
 * target to become an href. Scheme-relative URLs are rejected as external
 * network targets; ordinary relative paths, fragments, http(s), and mailto
 * remain useful in a file:// viewer.
 */
function safeHref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const href = value.trim();
  if (href.length === 0 || CONTROL_CHARACTERS.test(href) || /\s/.test(href) || href.includes("\\")) return undefined;
  if (href.startsWith("//")) return undefined;
  const scheme = SCHEME.exec(href)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== "http" && scheme !== "https" && scheme !== "mailto") return undefined;
  if (href.startsWith(":")) return undefined;

  try {
    const parsed = new URL(href, "https://offline.invalid/");
    if (scheme === "http" || scheme === "https") {
      if (parsed.protocol !== `${scheme}:`) return undefined;
    } else if (scheme === "mailto") {
      if (parsed.protocol !== "mailto:") return undefined;
    } else if (parsed.protocol !== "https:") {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return href;
}

function headingSlug(label: string): string {
  const normalized = label.normalize("NFKC").toLowerCase();
  const slug = Array.from(normalized)
    .map((character) => (/^\p{L}|^\p{N}/u.test(character) ? character : "-"))
    .join("")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "section";
}

function renderTocNodes(nodes: TocNode[]): string {
  return `<ul>${nodes
    .map(
      (node) =>
        `<li><a href="#${escapeHtml(node.heading.id)}">${escapeHtml(node.heading.label || "Untitled section")}</a>${
          node.children.length > 0 ? renderTocNodes(node.children) : ""
        }</li>`,
    )
    .join("")}</ul>`;
}

function buildToc(headings: HeadingInfo[]): string {
  const root: { children: TocNode[] } = { children: [] };
  const stack: Array<{ depth: number; node: TocNode }> = [];
  for (const heading of headings) {
    if (heading.token.depth < 2) continue;
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= heading.token.depth) stack.pop();
    const node: TocNode = { heading, children: [] };
    const parent = stack.length > 0 ? stack[stack.length - 1]!.node : root;
    parent.children.push(node);
    stack.push({ depth: heading.token.depth, node });
  }
  return root.children.length === 0
    ? ""
    : `<nav class="markdown-toc" aria-label="Table of contents"><h2>Contents</h2>${renderTocNodes(root.children)}</nav>`;
}

function renderNavigation(info: NavigationInfo): string {
  const previous = info.previous
    ? `<a href="#${escapeHtml(info.previous.id)}" rel="prev">Previous: ${escapeHtml(info.previous.label || "Untitled section")}</a>`
    : '<span class="nav-disabled" aria-disabled="true">Previous</span>';
  const next = info.next
    ? `<a href="#${escapeHtml(info.next.id)}" rel="next">Next: ${escapeHtml(info.next.label || "Untitled section")}</a>`
    : '<span class="nav-disabled" aria-disabled="true">Next</span>';
  return `<nav class="section-navigation" aria-label="Section navigation">${previous}${next}</nav>`;
}

/**
 * Render Markdown to a deterministic, safe, self-contained offline document.
 * Marked lexes once; the resulting token list is then rendered with a custom
 * renderer so unsafe raw HTML, links and images never become active markup.
 */
export function renderMarkdownDocumentHtml(markdown: string, options: MarkdownDocumentOptions = {}): string {
  const source = typeof markdown === "string" ? markdown : String(markdown ?? "");
  const markedOptions = { gfm: true, async: false as const };
  const tokens = marked.lexer(source, markedOptions);
  const textRenderer = new marked.TextRenderer();
  const textParser = new marked.Parser(markedOptions);
  const headings: HeadingInfo[] = [];
  const usedIds = new Set<string>();
  const nextSuffix = new Map<string, number>();

  marked.walkTokens(tokens, (token: Token) => {
    if (token.type !== "heading" || !("depth" in token) || !("tokens" in token)) return;
    const headingToken = token as Tokens.Heading;
    const label = textParser.parseInline(headingToken.tokens, textRenderer);
    const base = headingSlug(label);
    let suffix = nextSuffix.get(base) ?? 1;
    let id = suffix === 1 ? base : `${base}-${suffix}`;
    while (usedIds.has(id)) {
      suffix += 1;
      id = `${base}-${suffix}`;
    }
    nextSuffix.set(base, suffix + 1);
    usedIds.add(id);
    headings.push({ token: headingToken, id, label });
  });

  const headingByToken = new Map<Tokens.Heading, HeadingInfo>(headings.map((heading) => [heading.token, heading]));
  const levelTwo = headings.filter((heading) => heading.token.depth === 2);
  const navigationByToken = new Map<Tokens.Heading, NavigationInfo>();
  levelTwo.forEach((heading, index) => {
    navigationByToken.set(heading.token, {
      previous: levelTwo[index - 1],
      next: levelTwo[index + 1],
    });
  });

  const renderer = new marked.Renderer();
  renderer.heading = function (token) {
    const heading = headingByToken.get(token);
    const id = heading?.id ?? headingSlug(token.text);
    const label = this.parser.parseInline(token.tokens);
    const navigation = options.navigation !== false && token.depth === 2 && navigationByToken.has(token)
      ? renderNavigation(navigationByToken.get(token)!)
      : "";
    return `<h${token.depth} id="${escapeHtml(id)}" class="markdown-heading"><a class="heading-anchor" href="#${escapeHtml(id)}">${label}</a></h${token.depth}>${navigation}\n`;
  };
  renderer.html = function (token) {
    return escapeHtml(token.text);
  };
  renderer.text = function (token) {
    if ("tokens" in token && token.tokens) return this.parser.parseInline(token.tokens);
    return escapeHtml(token.text);
  };
  renderer.code = function (token) {
    const language = token.lang ? ` class="language-${escapeHtml(token.lang)}"` : "";
    return `<pre><code${language}>${escapeHtml(token.text)}</code></pre>\n`;
  };
  renderer.codespan = function (token) {
    return `<code>${escapeHtml(token.text)}</code>`;
  };
  renderer.link = function (token) {
    const label = this.parser.parseInline(token.tokens);
    const href = safeHref(token.href);
    if (href === undefined) return label;
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
    return `<a href="${escapeHtml(href)}"${title}>${label}</a>`;
  };
  renderer.image = function (token) {
    const imageTokens = token.tokens;
    const alt = imageTokens !== undefined ? this.parser.parseInline(imageTokens, this.parser.textRenderer) : token.text;
    return `<span class="markdown-image-alt">[Image: ${escapeHtml(alt)}]</span>`;
  };
  renderer.checkbox = function (token) {
    return `<input type="checkbox" disabled${token.checked ? " checked" : ""}> `;
  };
  renderer.tablecell = function (token) {
    const tag = token.header ? "th" : "td";
    const align = token.align ? ` align="${escapeHtml(token.align)}"` : "";
    return `<${tag}${align}>${this.parser.parseInline(token.tokens)}</${tag}>\n`;
  };

  const rendered = marked.Parser.parse(tokens, { ...markedOptions, renderer });
  const body = `<main class="markdown-document"><div class="markdown-container">${
    options.toc === false ? "" : buildToc(headings)
  }<article class="markdown-body">${rendered.trim().length > 0 ? rendered : '<p class="markdown-empty" role="status">This Markdown document is empty.</p>'}</article></div></main>`;

  return renderOfflineHtml({
    title: options.title ?? "Markdown document",
    lang: options.lang ?? "en",
    css: MARKDOWN_CSS,
    body,
    script: MARKDOWN_SCRIPT,
  });
}

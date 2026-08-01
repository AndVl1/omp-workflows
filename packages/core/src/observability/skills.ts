/**
 * Skill name scraper.
 *
 * The OMP runtime injects skills into the system prompt as
 * `skill://<name>` URIs (see omp-workflows CLAUDE.md / memory summary for
 * the URI contract). Each `before_agent_start` event carries the full
 * system prompt as `systemPrompt: string[]`; we scan for `skill://` URIs
 * and dedupe.
 *
 * Why scrape rather than listen to a dedicated event:
 *   - OMP's extension bus has no "skill_loaded" event
 *   - `before_agent_start` fires once per agent loop (main + subagents),
 *     so we naturally get a per-subagent view of which skills were active
 *   - The system prompt is the only authoritative list of what the model
 *     sees — anything else would be guesswork
 *
 * If a future omp version adds an explicit skill event, swap this for the
 * event subscription and keep the same `extractSkills` return shape.
 */

const SKILL_URI = /skill:\/\/([a-zA-Z0-9._/-]+)/g;
/**
 * Some extensions (notably the omp-workflows command generator) embed skill
 * names in backticks within `Available skills:` / `## <name>` blocks. Match
 * those as a fallback when no `skill://` URIs are present, but be conservative
 * — only lines that look like skill headers.
 */
const SKILL_HEADER = /^##\s+([a-z0-9][a-z0-9._-]{1,63})\s*$/im;

export function extractSkills(systemPrompt: ReadonlyArray<string>): string[] {
  const out = new Set<string>();
  const joined = systemPrompt.join("\n");
  // Primary: skill://<name> URIs.
  for (const m of joined.matchAll(SKILL_URI)) {
    if (m[1]) out.add(m[1]);
  }
  // Fallback: section headers, only if no URIs were found (header scraping
  // is noisier — a "## Usage" section in unrelated docs would match).
  if (out.size === 0) {
    const m = joined.match(SKILL_HEADER);
    if (m && m[1]) out.add(m[1]);
  }
  return Array.from(out).sort();
}

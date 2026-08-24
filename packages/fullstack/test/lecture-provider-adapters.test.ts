import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcquisitionLimits, LectureAcquisitionRequest, ResolvedVideoSource } from "@andvl1/omp-workflows-core";
import { parseYouTubeUrl } from "../src/lecture-acquisition/youtube-url.js";
import { YouTubePlaylistExpander } from "../src/lecture-acquisition/youtube-playlist.js";
import { GeminiYouTubeProvider } from "../src/lecture-acquisition/gemini.js";
import { LectureResearchConfigError, loadLectureResearchConfig } from "../src/lecture-acquisition/config.js";
const limits: AcquisitionLimits = {
  maxPages: 4,
  maxItems: 8,
  maxResponseBytes: 1_048_576,
  deadlineMs: 60_000,
  maxAttempts: 1,
  maxEvidenceSegmentsPerSource: 16,
};
const signal = new AbortController().signal;

function request(prompt = "Extract timestamped claims"): LectureAcquisitionRequest {
  return { sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", prompt, limits, rights: { automatedPublicVideoAnalysisApproved: true, ownedCaptionAccessApproved: false } };
}

 test("parseYouTubeUrl accepts canonical HTTPS video and playlist URLs and rejects unsupported forms", () => {
  assert.equal(parseYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ").kind, "video");
  assert.equal(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ").kind, "video");
  assert.equal(parseYouTubeUrl("https://www.youtube.com/playlist?list=PLfake123").kind, "playlist");
  for (const [url, code] of [
    ["http://www.youtube.com/watch?v=dQw4w9WgXcQ", "UNSUPPORTED_URL"],
    ["https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ", "UNSUPPORTED_URL"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&x=1", "UNSUPPORTED_URL"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "UNSUPPORTED_URL"],
    ["not a url", "INVALID_URL"],
  ] as const) {
    const result = parseYouTubeUrl(url);
    assert.equal("code" in result ? result.code : undefined, code, url);
  }
 });

test("YouTubePlaylistExpander paginates through official endpoint with bounded stable dedupe", async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const pages = [
    { items: [{ contentDetails: { videoId: "dQw4w9WgXcQ" }, snippet: { position: 2 } }, { contentDetails: { videoId: "9bZkp7q19f0" }, snippet: { position: 3 } }, { contentDetails: { videoId: "bad" } }], nextPageToken: "NEXT" },
    { items: [{ contentDetails: { videoId: "9bZkp7q19f0" } }, { contentDetails: { videoId: "M7lc1UVf-VE" }, snippet: { title: "Third" } }] },
  ]; let index = 0;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: new URL(String(input)), init: init! }); return new Response(JSON.stringify(pages[index++]), { status: 200, headers: { "content-type": "application/json" } }); };
  const parsed = parseYouTubeUrl("https://www.youtube.com/playlist?list=PLfake123");
  assert.equal(parsed.kind, "playlist");
  const result = await new YouTubePlaylistExpander({ fetch, apiKey: "fake-key", maxResponseBytes: 1_048_576 }).expand(parsed, limits, signal);
  assert.deepEqual(result.items.map((item) => item.videoId), ["dQw4w9WgXcQ", "9bZkp7q19f0", "M7lc1UVf-VE"]);
  assert.equal(result.truncated, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.origin + calls[0].url.pathname, "https://www.googleapis.com/youtube/v3/playlistItems");
  assert.equal(calls[0].url.searchParams.get("part"), "snippet,contentDetails");
  assert.equal(calls[0].url.searchParams.get("playlistId"), "PLfake123");
  assert.ok(calls.every((call) => !call.url.searchParams.has("key")));
  assert.ok(calls.every((call) => new Headers(call.init.headers).get("x-goog-api-key") === "fake-key"));
  assert.equal(calls[1].url.searchParams.get("pageToken"), "NEXT");
});

test("YouTubePlaylistExpander rejects streamed responses that exceed the byte limit", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"items":['));
      controller.enqueue(new Uint8Array(8));
      controller.close();
    },
  });
  const fetch = async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  const parsed = parseYouTubeUrl("https://www.youtube.com/playlist?list=PLfake123");
  assert.equal(parsed.kind, "playlist");
  const result = await new YouTubePlaylistExpander({ fetch, apiKey: "fake-key", maxResponseBytes: 12 }).expand(parsed, { ...limits, maxResponseBytes: 12 }, signal);
  assert.deepEqual(result.items, []);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.failures, [{ code: "LIMIT_EXCEEDED", provider: "youtube", message: "provider response exceeded the configured byte limit", retryable: false, attempts: 1, severity: "error" }]);
});

test("GeminiYouTubeProvider sends documented request and extracts current and legacy response text", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(input), init: init! }); return new Response(JSON.stringify({ steps: [{ content: [{ text: JSON.stringify({ segments: [{ quote: "claim" }] }) }] }] }), { status: 200 }); };
  const source: ResolvedVideoSource = { sourceId: "yt-video-dQw4w9WgXcQ", videoId: "dQw4w9WgXcQ", canonicalUrl: "https://youtu.be/dQw4w9WgXcQ" };
  const provider = new GeminiYouTubeProvider({ fetch, apiKey: "fake-key", model: "fake-model" });
  assert.deepEqual(await provider.analyzeYouTubeVideo(source, request(), signal), { segments: [{ quote: "claim" }] });
  const init = calls[0].init; const body = JSON.parse(String(init.body));
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal((init.headers as Record<string, string>)["x-goog-api-key"], "fake-key");
  assert.equal(body.model, "fake-model"); assert.equal(body.input[0].text, "Extract timestamped claims"); assert.equal(body.input[1].uri, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(body.response_format.type, "text"); assert.equal(body.response_format.mime_type, "application/json");
  const legacyFetch = async () => new Response(JSON.stringify({ outputs: [{ text: JSON.stringify({ segments: [] }) }] }), { status: 200 });
  assert.deepEqual(await new GeminiYouTubeProvider({ fetch: legacyFetch, apiKey: "fake-key", model: "fake-model" }).analyzeYouTubeVideo(source, request(), signal), { segments: [] });
});
test("loadLectureResearchConfig rejects non-official Gemini endpoints without network access", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lecture-research-config-"));
  try {
    await mkdir(join(cwd, ".omp"));
    await writeFile(join(cwd, ".omp", "lecture-research.json"), JSON.stringify({
      gemini: { endpoint: "https://127.0.0.1/v1beta", apiKeyEnv: "GEMINI_API_KEY" },
    }));
    await assert.rejects(
      loadLectureResearchConfig(cwd),
      (error: unknown) => {
        assert.ok(error instanceof LectureResearchConfigError);
        assert.equal(error.name, "LectureResearchConfigError");
        assert.equal(error.message, "Invalid gemini.endpoint");
        assert.doesNotMatch(error.message, /127\.0\.0\.1/);
        return true;
      },
    );
    await writeFile(join(cwd, ".omp", "lecture-research.json"), JSON.stringify({
      gemini: { endpoint: "https://generativelanguage.googleapis.com/v1beta", apiKeyEnv: "GEMINI_API_KEY" },
    }));
    const config = await loadLectureResearchConfig(cwd);
    assert.equal(config.gemini.endpoint, "https://generativelanguage.googleapis.com/v1beta");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

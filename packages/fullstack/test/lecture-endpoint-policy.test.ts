import { test } from "node:test";
import assert from "node:assert/strict";
import { endpointWithPath, EndpointPolicyError, validateEndpoint } from "../src/lecture-acquisition/endpoint-policy.js";
import { OpenAICompatibleTextAnalysis } from "../src/lecture-acquisition/text-analysis.js";

const official = (url: string, officialHost: "youtube" | "gemini" = "youtube") => validateEndpoint(url, { trust: "official-google", officialHost, provider: officialHost });

test("endpoint policy allows exact Google, trusted HTTPS, and loopback local providers", () => {
  assert.equal(official("https://www.googleapis.com/youtube/v3").origin, "https://www.googleapis.com");
  assert.equal(official("https://generativelanguage.googleapis.com", "gemini").origin, "https://generativelanguage.googleapis.com");
  assert.equal(validateEndpoint("https://openrouter.ai/api/v1", { trust: "trusted-remote", provider: "openai-compatible" }).pathname, "/api/v1");
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const endpoint = validateEndpoint(`http://${host}:11434/v1`, { trust: "local-loopback", provider: "ollama" });
    assert.equal(endpoint.url.protocol, "http:");
    assert.equal(endpointWithPath(endpoint, "/chat/completions").pathname, "/v1/chat/completions");
  }
});

test("endpoint policy rejects secret-bearing and authority ambiguity before fetch", () => {
  const rejected = [
    ["https://attacker.example/youtube/v3", { trust: "official-google", officialHost: "youtube", provider: "youtube" }],
    ["http://remote.example/v1", { trust: "trusted-remote", provider: "openai-compatible" }],
    ["http://192.168.1.10:11434/v1", { trust: "local-loopback", provider: "ollama" }],
    ["https://user:pass@openrouter.ai/api/v1", { trust: "trusted-remote", provider: "openai-compatible" }],
    ["https://openrouter.ai/api/v1?api_key=redacted", { trust: "trusted-remote", provider: "openai-compatible" }],
    ["https://openrouter.ai/api/v1#fragment", { trust: "trusted-remote", provider: "openai-compatible" }],
    ["https://openrouter.ai:bad/api/v1", { trust: "trusted-remote", provider: "openai-compatible" }],
  ] as const;
  for (const [url, policy] of rejected) assert.throws(() => validateEndpoint(url, policy), EndpointPolicyError);
  let calls = 0;
  assert.throws(() => new OpenAICompatibleTextAnalysis({ endpoint: "http://remote.example/v1", trust: "trusted-remote", provider: "openai-compatible", model: "fixture", apiKeyEnv: "TEST_KEY", maxResponseBytes: 1024, maxTranscriptCharacters: 1024, maxEvidenceSegments: 2, fetch: async () => { calls += 1; throw new Error("must not fetch"); } }), /endpoint/i);
  assert.equal(calls, 0);
});

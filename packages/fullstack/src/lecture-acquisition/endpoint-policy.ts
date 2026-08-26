export type EndpointTrust = "official-google" | "trusted-remote" | "local-loopback";

export type EndpointProvider =
  | "youtube"
  | "gemini"
  | "ollama"
  | "vllm"
  | "openrouter"
  | "openai-compatible"
  | "hosted-asr"
  | "authorized-media";

export interface EndpointPolicy {
  trust: EndpointTrust;
  provider?: EndpointProvider | string;
  /** Official policies may further constrain the endpoint family. */
  officialHost?: "youtube" | "gemini";
}

export interface ValidatedEndpoint {
  readonly url: URL;
  readonly origin: string;
  readonly pathname: string;
  readonly trust: EndpointTrust;
  readonly provider?: string;
}

export class EndpointPolicyError extends Error {
  readonly code = "ENDPOINT_POLICY_REJECTED" as const;

  constructor(message = "Provider endpoint rejected by policy") {
    super(message);
    this.name = "EndpointPolicyError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const OFFICIAL_HOSTS: Record<"youtube" | "gemini", string> = {
  youtube: "www.googleapis.com",
  gemini: "generativelanguage.googleapis.com",
};
const SECRET_QUERY_KEY = /(?:key|token|secret|password|passwd|authorization|credential|api[-_]?key|access[-_]?token)/i;

function authorityHasExplicitPort(raw: string): boolean {
  const authority = raw.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1] ?? "";
  if (!authority || authority.includes("@")) return false;
  if (authority.startsWith("[")) {
    const closing = authority.indexOf("]");
    return closing >= 0 && authority.slice(closing + 1).startsWith(":");
  }
  return authority.includes(":");
}

function canonicalPath(pathname: string): string {
  const normalized = pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

/**
 * Validate an endpoint before URL path joining or fetch. The returned URL has
 * no query/fragment/userinfo and carries no credential material.
 */
export function validateEndpoint(raw: string, policy: EndpointPolicy): ValidatedEndpoint {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2_048 || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new EndpointPolicyError("Endpoint must be a bounded URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new EndpointPolicyError("Endpoint URL is malformed");
  }
  if (parsed.username || parsed.password) throw new EndpointPolicyError("Endpoint userinfo is not allowed");
  if (parsed.hash) throw new EndpointPolicyError("Endpoint fragments are not allowed");
  if (parsed.search) {
    const params = [...parsed.searchParams.keys()];
    if (params.some((key) => SECRET_QUERY_KEY.test(key))) throw new EndpointPolicyError("Endpoint query credentials are not allowed");
    throw new EndpointPolicyError("Endpoint query parameters are not allowed");
  }
  const host = parsed.hostname.toLowerCase();
  const portExplicit = authorityHasExplicitPort(raw);
  if (policy.trust === "official-google") {
    if (parsed.protocol !== "https:") throw new EndpointPolicyError("Official Google endpoints require HTTPS");
    const expected = policy.officialHost ?? (policy.provider === "gemini" ? "gemini" : "youtube");
    if (host !== OFFICIAL_HOSTS[expected]) throw new EndpointPolicyError("Endpoint host is not an allowlisted Google host");
    if (portExplicit) throw new EndpointPolicyError("Official Google endpoints do not allow explicit ports");
  } else if (policy.trust === "trusted-remote") {
    if (parsed.protocol !== "https:") throw new EndpointPolicyError("Trusted remote endpoints require HTTPS");
    if (!host) throw new EndpointPolicyError("Trusted endpoint must have a hostname");
    if (portExplicit && (!parsed.port || Number(parsed.port) < 1 || Number(parsed.port) > 65_535)) {
      throw new EndpointPolicyError("Endpoint port is invalid");
    }
  } else if (policy.trust === "local-loopback") {
    if (parsed.protocol !== "http:") throw new EndpointPolicyError("Local loopback endpoints require HTTP");
    if (!LOOPBACK_HOSTS.has(host)) throw new EndpointPolicyError("Only loopback endpoints are allowed for local HTTP");
    if (policy.provider !== undefined && policy.provider !== "ollama" && policy.provider !== "vllm") {
      throw new EndpointPolicyError("Local HTTP is supported only for Ollama or vLLM");
    }
    if (portExplicit && (!parsed.port || Number(parsed.port) < 1 || Number(parsed.port) > 65_535)) {
      throw new EndpointPolicyError("Endpoint port is invalid");
    }
  } else {
    throw new EndpointPolicyError("Unknown endpoint trust policy");
  }
  const sanitized = new URL(parsed.origin);
  sanitized.pathname = canonicalPath(parsed.pathname);
  return Object.freeze({
    url: sanitized,
    origin: sanitized.origin,
    pathname: sanitized.pathname,
    trust: policy.trust,
    ...(policy.provider ? { provider: policy.provider } : {}),
  });
}

export const validateProviderEndpoint = validateEndpoint;

export function endpointWithPath(endpoint: ValidatedEndpoint, path: string): URL {
  if (!path.startsWith("/")) throw new EndpointPolicyError("Provider path must be absolute");
  if (/[\u0000-\u001f\u007f?#]/.test(path)) throw new EndpointPolicyError("Provider path is invalid");
  const result = new URL(endpoint.url);
  result.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  return result;
}

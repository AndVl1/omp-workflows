import type { AcquisitionFailure, ParsedLectureUrl } from "@andvl1/omp-workflows-core";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"]);

function failure(code: "INVALID_URL" | "UNSUPPORTED_URL", message: string): AcquisitionFailure {
  return { code, message, retryable: false, attempts: 0, severity: "error" };
}

export function parseYouTubeUrl(input: string): ParsedLectureUrl | AcquisitionFailure {
  if (typeof input !== "string") return failure("INVALID_URL", "URL must be a string");
  const value = input.trim();
  if (value.length === 0 || value.length > 2048) return failure("INVALID_URL", "URL is empty or too long");
  let url: URL;
  try { url = new URL(value); } catch { return failure("INVALID_URL", "Malformed URL"); }
  if (url.protocol !== "https:") return failure("UNSUPPORTED_URL", "Only HTTPS YouTube URLs are supported");
  if (!HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.port || url.hash) return failure("UNSUPPORTED_URL", "Unsupported YouTube host or URL component");
  const params = url.searchParams;
  if (url.hostname.toLowerCase() === "youtu.be") {
    if (!/^\/[A-Za-z0-9_-]{11}$/.test(url.pathname) || [...params.keys()].length) return failure("UNSUPPORTED_URL", "Unsupported YouTube URL");
    const id = url.pathname.slice(1);
    return { kind: "video", videoId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}` };
  }
  if (url.pathname === "/watch" && params.has("v") && [...params.keys()].every((key) => key === "v") && VIDEO_ID.test(params.get("v") ?? "")) {
    const id = params.get("v")!;
    return { kind: "video", videoId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}` };
  }
  if (url.pathname === "/playlist" && params.has("list") && [...params.keys()].every((key) => key === "list") && PLAYLIST_ID.test(params.get("list") ?? "")) {
    const id = params.get("list")!;
    return { kind: "playlist", playlistId: id, canonicalUrl: `https://www.youtube.com/playlist?list=${id}` };
  }
  return failure("UNSUPPORTED_URL", "Unsupported YouTube URL");
}

export const canonicalizeYouTubeUrl = parseYouTubeUrl;

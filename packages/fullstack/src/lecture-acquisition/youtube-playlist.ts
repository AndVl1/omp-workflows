import type { AcquisitionLimits, BoundedSourceSet, ParsedLectureUrl, PlaylistExpander } from "@andvl1/omp-workflows-core";
import { classifyProviderHttpStatus, readBoundedResponseText, safeProviderError, AcquisitionProviderError } from "./provider-errors.js";

const PROVIDER = "youtube";
export interface YouTubePlaylistOptions { fetch: typeof globalThis.fetch; apiKey: string; endpoint?: string; maxResponseBytes?: number }

export class YouTubePlaylistExpander implements PlaylistExpander {
  constructor(private readonly options: YouTubePlaylistOptions) {}
  async expand(parsed: Extract<ParsedLectureUrl, { kind: "playlist" }>, limits: AcquisitionLimits, signal: AbortSignal): Promise<BoundedSourceSet> {
    const items: BoundedSourceSet["items"] = []; const seen = new Set<string>(); let token: string | undefined; let pages = 0; let truncated = false; let totalKnown: number | undefined;
    try {
      while (pages < limits.maxPages && items.length < limits.maxItems) {
        const url = this.options.endpoint === undefined
          ? new URL("https://www.googleapis.com/youtube/v3/playlistItems")
          : (() => {
            const joined = new URL(this.options.endpoint);
            joined.pathname = `${joined.pathname.replace(/\/+$/, "")}/playlistItems`;
            joined.username = ""; joined.password = ""; joined.hash = "";
            return joined;
          })();
        url.searchParams.set("part", "snippet,contentDetails"); url.searchParams.set("playlistId", parsed.playlistId); url.searchParams.set("maxResults", String(Math.min(50, limits.maxItems - items.length)));
        if (token) url.searchParams.set("pageToken", token);
        const response = await this.options.fetch(url, { method: "GET", headers: { "x-goog-api-key": this.options.apiKey }, signal });
        const body = await readBoundedResponseText(response, this.options.maxResponseBytes ?? limits.maxResponseBytes, PROVIDER);
        if (!response.ok) throw classifyProviderHttpStatus(PROVIDER, response.status, body, { notFoundCode: "PLAYLIST_NOT_FOUND" });
        let data: unknown; try { data = JSON.parse(body); } catch { throw new AcquisitionProviderError("INVALID_PROVIDER_RESPONSE", "provider returned invalid playlist data", { provider: PROVIDER }); }
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new AcquisitionProviderError("INVALID_PROVIDER_RESPONSE", "provider returned invalid playlist data", { provider: PROVIDER });
        const root = data as { pageInfo?: { totalResults?: unknown }; items?: unknown; nextPageToken?: unknown };
        if (root.items !== undefined && !Array.isArray(root.items)) throw new AcquisitionProviderError("INVALID_PROVIDER_RESPONSE", "provider returned invalid playlist data", { provider: PROVIDER });
        totalKnown = typeof root.pageInfo?.totalResults === "number" ? root.pageInfo.totalResults : totalKnown;
        for (const entry of Array.isArray(root.items) ? root.items : []) {
          if (!entry || typeof entry !== "object" || !("contentDetails" in entry)) continue;
          const details = entry.contentDetails;
          const id = details && typeof details === "object" && "videoId" in details && typeof details.videoId === "string" ? details.videoId : undefined;
          if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id) || seen.has(id)) continue;
          seen.add(id);
          const snippet = "snippet" in entry && entry.snippet && typeof entry.snippet === "object" ? entry.snippet : undefined;
          const position = snippet && "position" in snippet && typeof snippet.position === "number" ? snippet.position : undefined;
          const title = snippet && "title" in snippet && typeof snippet.title === "string" ? snippet.title : undefined;
          items.push({ sourceId: `yt-video-${id}`, videoId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}`, playlistId: parsed.playlistId, position, title });
          if (items.length >= limits.maxItems) break;
        }
        pages++;
        const nextPageToken = "nextPageToken" in root && typeof root.nextPageToken === "string" ? root.nextPageToken : undefined;
        token = nextPageToken;
        if (!token) break;
      }
      truncated = Boolean(token) || (items.length >= limits.maxItems && (totalKnown === undefined || totalKnown > items.length));
      return { requested: parsed, items, truncated, totalKnown, failures: [] };
    } catch (error) { const failure = safeProviderError(PROVIDER, error); return { requested: parsed, items, truncated: true, totalKnown, failures: [{ code: failure.code, provider: PROVIDER, message: failure.message, retryable: failure.retryable, attempts: 1, severity: "error" }] }; }
  }
}

export async function expandYouTubePlaylist(options: YouTubePlaylistOptions, parsed: Extract<ParsedLectureUrl, { kind: "playlist" }>, limits: AcquisitionLimits, signal: AbortSignal) { return new YouTubePlaylistExpander(options).expand(parsed, limits, signal); }

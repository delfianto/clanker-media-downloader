import type { HosterId } from "../types/hoster";
import type { GalleryJobItem } from "../types/messages";
import { crossOriginFetchText } from "./fetcher";
import { withRetry } from "./retry";
import { appendLog } from "./logger";
import { getModel } from "../hosts/index";

// Retry transient HTTP failures (502, 503, 504, network errors) with backoff.
// Both the viewer page fetch and hoster-specific resolveUrl hooks (e.g. bunkr's
// sign API) can hit these under load.
export function fetchWithRetry(
  url: string,
  jobId: string,
  label: string,
  maxRetries = 3,
): Promise<{ text: string }> {
  return withRetry(() => crossOriginFetchText(url), {
    maxRetries,
    onRetry: (attempt, backoff) =>
      void appendLog("debug", `Retry ${attempt}/${maxRetries} for ${label} in ${backoff}ms`, jobId),
  });
}

// Resolve a gallery item to a downloadable URL. The flow:
//   1. For "resolved" items, the URL is already known.
//   2. If the model provides resolveFromViewer, let it handle the resolution (no framework GET).
//   3. Otherwise, for "resolve-viewer" items, fetch the viewer page HTML.
//   4. If the model provides extractFromViewer, call it (owns all hoster-specific
//      parsing: regex, <source> fallbacks, maintenance detection, filename).
//   5. Otherwise, use the item's regex extractor (generic fallback).
//   6. If the model provides resolveUrl, call it (e.g. bunkr's sign API).
//   7. Otherwise, return the raw URL directly.
export async function resolveItem(
  item: GalleryJobItem,
  jobId: string,
  hosterId: HosterId,
): Promise<string> {
  if (item.kind === "resolved") return item.imageUrl;

  const model = getModel(hosterId);
  const gc = model?.galleryConfig;

  // Self-resolving hosts own their fetching — no wasted framework GET. Their
  // fetches bypass fetchWithRetry, so apply the same transient-retry policy here.
  if (gc?.resolveFromViewer) {
    const resolveFromViewer = gc.resolveFromViewer;
    const resolved = await withRetry(() => resolveFromViewer(item.viewerUrl), {
      onRetry: (attempt, backoff) =>
        void appendLog(
          "debug",
          `Retry ${attempt} for resolving ${item.viewerUrl} in ${backoff}ms`,
          jobId,
        ),
    });
    if (resolved.filename) {
      item.filename = resolved.filename;
    }
    return resolved.url;
  }

  void appendLog("debug", `Fetching viewer: ${item.viewerUrl}`, jobId);
  const { text } = await fetchWithRetry(item.viewerUrl, jobId, "viewer page");

  let rawUrl: string | undefined;
  let filenameOverride: string | undefined;

  // Prefer the model's custom extractor (e.g. bunkr: jsCDN + <source> + maintenance).
  if (gc?.extractFromViewer) {
    const result = gc.extractFromViewer(text);
    if (result) {
      rawUrl = result.url.replace(/\\/g, "");
      filenameOverride = result.filename;
    }
  }

  // Generic fallback: regex extractor on the HTML.
  if (!rawUrl && item.extractor) {
    const match = new RegExp(item.extractor).exec(text);
    if (match?.[1]) {
      rawUrl = match[1].replace(/\\/g, "");
    }
  }

  if (filenameOverride) {
    item.filename = filenameOverride;
  }

  if (gc?.resolveUrl) {
    if (!rawUrl) {
      void appendLog(
        "error",
        `Extraction failed prior to resolveUrl for ${item.viewerUrl} (HTML snippet: ${text.slice(0, 300).replace(/\s+/g, " ")})`,
        jobId,
      );
      throw new Error(`extraction failed prior to resolveUrl for ${item.viewerUrl}`);
    }
    void appendLog("debug", `Resolving URL: ${rawUrl}`, jobId);
    const resolveUrlHook = gc.resolveUrl;
    const extractedUrl = rawUrl;
    const resolved = await withRetry(() => resolveUrlHook(extractedUrl, item.viewerUrl), {
      onRetry: (attempt, backoff) =>
        void appendLog(
          "debug",
          `Retry ${attempt} for resolving ${extractedUrl} in ${backoff}ms`,
          jobId,
        ),
    });
    if (typeof resolved === "string") {
      return resolved;
    }
    if (resolved.filename) {
      item.filename = resolved.filename;
    }
    return resolved.url;
  }

  if (!rawUrl) {
    void appendLog(
      "error",
      `Extractor found no match in ${item.viewerUrl} (HTML snippet: ${text.slice(0, 300).replace(/\s+/g, " ")})`,
      jobId,
    );
    throw new Error(`extractor found no match in ${item.viewerUrl}`);
  }

  return rawUrl;
}

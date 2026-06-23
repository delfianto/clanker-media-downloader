import browser from "webextension-polyfill";
import type { MDOffscreenDownloadResponse } from "../types/messages";

// Mirrors the service worker's onMessage convention (see background/index.ts):
// return a Promise for an async response, or undefined when not handled. The
// webextension-polyfill types reject the legacy `sendResponse` + `return true`
// shape, so the async work is wrapped in an IIFE whose Promise is returned.
browser.runtime.onMessage.addListener(
  (msg: unknown): Promise<MDOffscreenDownloadResponse> | undefined => {
    const m = msg as Record<string, unknown>;

    if (m["type"] === "MD_OFFSCREEN_DOWNLOAD") {
      const url = m["url"] as string;
      return (async (): Promise<MDOffscreenDownloadResponse> => {
        try {
          const res = await fetch(url, { credentials: "include" });
          if (!res.ok) {
            throw new Error(`HTTP error! status: ${res.status}`);
          }
          const blob = await res.blob();
          const blobUrl = URL.createObjectURL(blob);
          return { blobUrl };
        } catch (err) {
          console.error("[md-offscreen] Fetch/Blob URL creation failed:", err);
          return { error: err instanceof Error ? err.message : String(err) };
        }
      })();
    }

    if (m["type"] === "MD_OFFSCREEN_CLEANUP") {
      const blobUrl = m["blobUrl"] as string;
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    }

    return undefined;
  },
);

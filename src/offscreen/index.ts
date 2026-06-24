import browser from "webextension-polyfill";
import type { MDOffscreenDownloadResponse } from "../types/messages";

// Mirrors the service worker's onMessage convention (see background/index.ts):
// return a Promise for an async response, or undefined when not handled. The
// webextension-polyfill types reject the legacy `sendResponse` + `return true`
// shape, so the async work is wrapped in an IIFE whose Promise is returned.

// Keep-alive ping via Port: A long-lived port connection is the most reliable
// way to keep an MV3 Service Worker alive. Chrome limits port lifetimes to 5
// minutes, so we automatically reconnect when it disconnects. We also send a
// ping over the port every 20s to ensure the 30s idle timer is constantly reset.
let keepAlivePort: browser.Runtime.Port | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;

function connectKeepAlive() {
  keepAlivePort = browser.runtime.connect({ name: "MD_KEEPALIVE_PORT" });

  keepAlivePort.onDisconnect.addListener(() => {
    if (pingInterval) clearInterval(pingInterval);
    // Reconnect immediately if the port is closed (e.g. by Chrome's 5-minute limit)
    setTimeout(connectKeepAlive, 100);
  });

  if (pingInterval) clearInterval(pingInterval);
  pingInterval = setInterval(() => {
    keepAlivePort?.postMessage("ping");
  }, 20000);
}
connectKeepAlive();
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

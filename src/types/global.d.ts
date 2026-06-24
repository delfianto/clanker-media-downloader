import type { HosterId, RedirectRule } from "./hoster";

// Re-export so settings/options/popup code can import HosterId from "../types/global".
export type { HosterId } from "./hoster";

// Stored in browser.storage.local — user overrides ONLY. Defaults are never
// stored; they live in each HosterModel and are merged in at runtime
// (see settings/resolve.ts). This means new extension versions ship improved
// defaults to users who haven't overridden them.
export type HosterOverride = {
  enabled: boolean; // always stored (default true)
  redirectRules: RedirectRule[] | null; // null = "use model defaults"
  cssOverrides: string; // empty string = none
  useFallbackName?: boolean; // imagebam: use file ID when filename is UUID/mojibake
};

export type Settings = {
  enabled: boolean;
  hosters: Record<HosterId, HosterOverride>;
  // Gallery download settings. Required (not optional) so storage.local.get(DEFAULT_SETTINGS)
  // always fills them — no undefined footgun with exactOptionalPropertyTypes.
  maxParallelImg: number; // 1–10; concurrent image downloads per gallery job
  maxParallelVid: number; // 1–5; concurrent video/audio downloads (CDN throttles large files)
  downloadDirectory: string; // relative download directory inside browser downloads dir; "" = none
  autoFolderPerAlbum: boolean; // if true: downloads/{directory}/{albumId}/file.ext
  verboseLogging: boolean; // if true: SW emits debug-level entries to the Logs tab
  maxDownloadRetries: number; // 0–10; number of retry attempts for transient download errors
  // Skip downloading files that already exist in history (same subfolder +
  // displayName). Uses the IDB [subfolder+displayName] composite index — O(1)
  // per item. Persists across SW/browser restarts. Independent of
  // chrome.downloads (which the user clears).
  skipExistingFiles: boolean;
};

// Payload delivered from isolated.ts (ISOLATED, can read storage) to main.ts
// (MAIN, cannot) over the __md_config__ CustomEvent bridge. isolated.ts only
// dispatches when the extension + matched hoster are enabled, so the mere arrival
// of this event is the signal for main.ts to activate that hoster's adapter.
// Gallery settings are embedded here so MAIN world adapters don't need a
// separate storage read.
export type MDConfig = {
  hosterId: HosterId;
  pageType: "viewer" | "gallery";
  maxParallelImg: number;
  maxParallelVid: number;
  downloadDirectory: string;
  autoFolderPerAlbum: boolean;
  useFallbackName?: boolean;
};

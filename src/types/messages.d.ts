// Message shapes for the two hops a download takes:
//   MAIN ──postMessage──▶ ISOLATED ──runtime.sendMessage──▶ background SW
// and the responses back.
//
// The two hops have DIFFERENT wire formats for the image bytes on purpose:
//
//   • SW → ISOLATED uses browser.runtime.sendMessage, which Chrome serialises as
//     JSON by default (structured clone is opt-in and Chrome 148+ only). An
//     ArrayBuffer would be silently dropped, so the SW returns the bytes as a
//     base64 string instead — JSON-safe on every Chrome/Firefox version.
//   • ISOLATED → MAIN uses window.postMessage, which is real structured clone.
//     ISOLATED decodes the base64 back into an ArrayBuffer and transfers it
//     zero-copy (see MDMainResponse + the [buffer] transferable).

import type { DownloadJob, DownloadLog, DownloadJobItem } from "./jobs";
import type { HosterId } from "./hoster";

// ── Single-image download (existing) ────────────────────────────────────────

// ISOLATED → background service worker (browser.runtime.sendMessage)
export type MDFetchBlobRequest = {
  type: "MD_FETCH_BLOB";
  url: string;
};

export type MDFetchBlobResponse = { base64: string; contentType: string } | { error: string };

// MAIN → ISOLATED (window.postMessage)
export type MDMainRequest = {
  type: "MD_REQUEST";
  id: string;
  url: string;
};

// Decoded bytes handed to the MAIN world. ISOLATED reconstructs the ArrayBuffer
// from base64 and posts it as a transferable, so MAIN gets it zero-copy.
export type MDBlobResult = { buffer: ArrayBuffer; contentType: string } | { error: string };

// ISOLATED → MAIN (window.postMessage; result.buffer passed as a transferable)
export type MDMainResponse = {
  type: "MD_RESPONSE";
  id: string;
  result: MDBlobResult;
};

// ── Gallery batch download ───────────────────────────────────────────────────

// A gallery item whose image URL is already known (thumbnail-transform / anchor-href).
// A gallery item that requires the SW to fetch a viewer page to extract the URL.
// needsSign: true signals the bunkr sign-API step after extraction.
export type GalleryJobItem =
  | {
      kind: "resolved";
      imageUrl: string;
      filename: string;
      subfolder?: string;
      // The hoster/viewer page URL for human verification (e.g. imx.to/i/xxx).
      // When the image was resolved directly from a thumbnail, this preserves
      // the page a human can open to check if a failed link is truly dead.
      // Absent for hosters that don't have a per-file viewer page.
      sourceUrl?: string;
    }
  | {
      kind: "resolve-viewer";
      viewerUrl: string;
      extractor?: string;
      filename: string;
      subfolder?: string;
    };

// MAIN → ISOLATED → SW: kick off a gallery download job.
export type MDGalleryStartRequest = {
  type: "MD_GALLERY_START";
  jobId: string;
  hosterId: HosterId;
  subfolder: string;
  items: GalleryJobItem[];
  maxParallelImg: number;
  maxParallelVid: number;
  postedAt?: number | undefined;
};

// SW → options page (via chrome.runtime.sendMessage — bypasses MAIN/ISOLATED relay).
export type MDJobProgressMessage = {
  type: "MD_JOB_PROGRESS";
  jobId: string;
  completedCount: number;
  totalCount: number;
  failedCount: number;
  status: "running" | "done" | "error" | "canceled";
  items?: DownloadJobItem[];
};

// Options page → SW: request the current job list for the Downloads tab.
export type MDListJobsRequest = { type: "MD_LIST_JOBS" };
export type MDListJobsResponse = { jobs: DownloadJob[] };

// Options page → SW: request deletion of a specific job from history.
export type MDDeleteJobRequest = {
  type: "MD_DELETE_JOB";
  jobId: string;
};

// Options page → SW: request cancel/stop of a specific running job.
export type MDCancelJobRequest = {
  type: "MD_CANCEL_JOB";
  jobId: string;
};

// Options page → SW: request resuming of a specific cancelled/errored job.
export type MDResumeJobRequest = {
  type: "MD_RESUME_JOB";
  jobId: string;
};

// Options page → SW: request global stop of all running/queued jobs.
export type MDStopAllJobsRequest = {
  type: "MD_STOP_ALL_JOBS";
};

// Options page → SW: request global resume of all cancelled/errored jobs.
export type MDResumeAllJobsRequest = {
  type: "MD_RESUME_ALL_JOBS";
};

// Options page → SW: wipe all job history. Cancels any running jobs first, then
// clears storage — all through runInStorageQueue so it can't race with an
// in-flight upsertJob that would otherwise write the stale list back.
export type MDClearJobsRequest = {
  type: "MD_CLEAR_JOBS";
};

// ── Crawl phase (girlsreleased listing → per-set resolution) ─────────────────
// MAIN → ISOLATED → SW. The crawl is a tracked, visible, cancellable job so the
// user sees "Crawling 12/154 sets…" in the Downloads tab BEFORE any download
// starts. Only when the crawl completes (and wasn't cancelled) does the MAIN
// world post the MD_GALLERY_START burst for each resolved set.

export type MDCrawlStartRequest = {
  type: "MD_CRAWL_START";
  crawlId: string;
  hosterId: HosterId;
  albumName: string;
  setCount: number;
};

export type MDCrawlProgressRequest = {
  type: "MD_CRAWL_PROGRESS";
  crawlId: string;
  resolvedCount: number;
  failedCount: number;
  setCount: number;
};

export type MDCrawlDoneRequest = {
  type: "MD_CRAWL_DONE";
  crawlId: string;
  aborted: boolean;
};

// SW → options page: a single log entry to append live in the Logs tab.
export type MDLogMessage = { type: "MD_LOG"; entry: DownloadLog };

// ── Offscreen download messages ──────────────────────────────────────────────
export type MDOffscreenDownloadRequest = {
  type: "MD_OFFSCREEN_DOWNLOAD";
  url: string;
};

export type MDOffscreenDownloadResponse = { blobUrl: string } | { error: string };

export type MDOffscreenCleanupRequest = {
  type: "MD_OFFSCREEN_CLEANUP";
  blobUrl: string;
};

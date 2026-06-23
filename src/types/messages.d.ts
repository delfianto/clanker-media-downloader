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

import type { DownloadJob } from "./jobs";
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
  | { kind: "resolved"; imageUrl: string; filename: string }
  | {
      kind: "resolve-viewer";
      viewerUrl: string;
      extractor: string;
      filename: string;
      needsSign?: true;
    };

// MAIN → ISOLATED → SW: kick off a gallery download job.
export type MDGalleryStartRequest = {
  type: "MD_GALLERY_START";
  jobId: string;
  hosterId: HosterId;
  subfolder: string;
  items: GalleryJobItem[];
  maxParallel: number;
};

// SW → options page (via chrome.runtime.sendMessage — bypasses MAIN/ISOLATED relay).
export type MDJobProgressMessage = {
  type: "MD_JOB_PROGRESS";
  jobId: string;
  completedCount: number;
  totalCount: number;
  failedCount: number;
  status: "running" | "done" | "error";
};

// Options page → SW: request the current job list for the Downloads tab.
export type MDListJobsRequest = { type: "MD_LIST_JOBS" };
export type MDListJobsResponse = { jobs: DownloadJob[] };

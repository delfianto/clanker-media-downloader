import type { HosterId } from "./hoster";
import type { GalleryJobItem } from "./messages";

export type DownloadJobStatus = "running" | "done" | "error" | "canceled";

export type LogLevel = "info" | "warn" | "error" | "debug";

// Persisted in chrome.storage.local under key "downloadLogs" as DownloadLog[].
// Written by the SW logger; read + cleared by the options page Logs tab.
export type DownloadLog = {
  ts: number;
  level: LogLevel;
  msg: string;
  jobId?: string;
};

export type DownloadJobItem = {
  displayName: string;
  filename: string;
  status: "pending" | "running" | "done" | "error";
  error?: string;
  // The hoster/viewer page URL for human verification — clicking the filename
  // in the Downloads tab opens this in a new tab so the user can check whether
  // a failed link is truly dead. Absent when no viewer page is known.
  sourceUrl?: string;
};

// Persisted in chrome.storage.local under key "downloadJobs" as DownloadJob[].
// Written by the SW; read by the options page Downloads tab.
export type DownloadJob = {
  jobId: string;
  hosterId: HosterId;
  subfolder: string;
  totalCount: number;
  completedCount: number;
  failedCount: number;
  status: DownloadJobStatus;
  startedAt: number;
  items?: DownloadJobItem[];
  originalItems?: GalleryJobItem[] | undefined;
  maxParallelImg?: number | undefined;
  maxParallelVid?: number | undefined;
  postedAt?: number | undefined;
  // True for a crawl-phase job (girlsreleased listing → per-set resolution).
  // Such jobs show "Crawling N / M sets" instead of file counts, and don't
  // carry per-file items — the actual downloads spawn as their own jobs once
  // the crawl completes.
  isCrawl?: boolean;
};

import type { HosterId } from "./hoster";

export type DownloadJobStatus = "running" | "done" | "error";

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
};

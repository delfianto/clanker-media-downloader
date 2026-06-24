import browser from "webextension-polyfill";

interface PendingDownload {
  resolve: () => void;
  reject: (err: Error) => void;
  jobId?: string;
}

const pendingDownloads = new Map<number, PendingDownload>();

browser.downloads.onChanged.addListener((delta) => {
  if (delta.state === undefined) return;
  const pending = pendingDownloads.get(delta.id);
  if (!pending) return;

  if (delta.state.current === "complete") {
    pendingDownloads.delete(delta.id);
    pending.resolve();
  } else if (delta.state.current === "interrupted") {
    pendingDownloads.delete(delta.id);
    pending.reject(
      new Error(`download interrupted${delta.error ? `: ${delta.error.current}` : ""}`),
    );
  } else if (delta.state.current === "canceled") {
    pendingDownloads.delete(delta.id);
    pending.reject(new Error("download canceled"));
  }
});

export function trackDownload(downloadId: number, jobId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    pendingDownloads.set(downloadId, { resolve, reject, jobId });
  });
}

export function cancelActiveDownloads(jobId: string): void {
  for (const [downloadId, pending] of pendingDownloads.entries()) {
    if (pending.jobId === jobId) {
      browser.downloads.cancel(downloadId).catch(() => {});
    }
  }
}

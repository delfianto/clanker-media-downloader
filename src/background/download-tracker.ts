import browser from "webextension-polyfill";

interface PendingDownload {
  resolve: () => void;
  reject: (err: Error) => void;
  jobId?: string;
  desiredFilename?: string;
}

const pendingDownloads = new Map<number, PendingDownload>();

// Use chrome.downloads since webextension-polyfill might be missing onDeterminingFilename
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).chrome.downloads.onDeterminingFilename.addListener(
  (item: any, suggest: any) => {
    const pending = pendingDownloads.get(item.id);
    if (pending && pending.desiredFilename) {
      // Force Chrome to use our filename instead of the CDN's Content-Disposition header.
      // Without this, Chrome ignores the 'filename' parameter we passed to downloads.download()
      // if the server responds with an explicit Content-Disposition header, dropping the file
      // directly into ~/Downloads with the CDN's mojibake garbage name.
      suggest({ filename: pending.desiredFilename, conflictAction: "uniquify" });
    } else {
      suggest();
    }
  },
);

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

export function trackDownload(
  downloadId: number,
  jobId: string,
  desiredFilename?: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    pendingDownloads.set(downloadId, {
      resolve,
      reject,
      jobId,
      ...(desiredFilename ? { desiredFilename } : {}),
    });
  });
}

export function cancelActiveDownloads(jobId: string): void {
  for (const [downloadId, pending] of pendingDownloads.entries()) {
    if (pending.jobId === jobId) {
      browser.downloads.cancel(downloadId).catch(() => {});
    }
  }
}

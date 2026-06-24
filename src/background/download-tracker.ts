import browser from "webextension-polyfill";

interface PendingDownload {
  resolve: () => void;
  reject: (err: Error) => void;
  jobId?: string;
  desiredFilename?: string;
}

const pendingDownloads = new Map<number, PendingDownload>();
const pendingFilenames = new Map<string, string[]>();

export function preRegisterFilename(url: string, desiredFilename: string): void {
  const list = pendingFilenames.get(url) || [];
  list.push(desiredFilename);
  pendingFilenames.set(url, list);
}

export function unregisterFilename(url: string, desiredFilename: string): void {
  const list = pendingFilenames.get(url);
  if (!list) return;
  const idx = list.indexOf(desiredFilename);
  if (idx !== -1) {
    list.splice(idx, 1);
  }
  if (list.length === 0) {
    pendingFilenames.delete(url);
  }
}

// Use chrome.downloads since webextension-polyfill might be missing onDeterminingFilename
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).chrome.downloads.onDeterminingFilename.addListener(
  (item: any, suggest: any) => {
    // 1. Try by download ID first (if trackDownload won the race)
    const pending = pendingDownloads.get(item.id);
    if (pending && pending.desiredFilename) {
      suggest({ filename: pending.desiredFilename, conflictAction: "uniquify" });
      return;
    }

    // 2. Try by URL (if onDeterminingFilename won the race)
    const urlList = pendingFilenames.get(item.url);
    if (urlList && urlList.length > 0) {
      const desiredFilename = urlList.shift()!;
      if (urlList.length === 0) pendingFilenames.delete(item.url);
      suggest({ filename: desiredFilename, conflictAction: "uniquify" });
      return;
    }

    suggest();
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
  url?: string,
): Promise<void> {
  if (url && desiredFilename) {
    unregisterFilename(url, desiredFilename);
  }
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

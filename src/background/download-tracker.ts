import browser from "webextension-polyfill";

interface PendingDownload {
  resolve: () => void;
  reject: (err: Error) => void;
  jobId?: string;
  desiredFilename?: string;
}

const pendingDownloads = new Map<number, PendingDownload>();
export async function preRegisterFilename(url: string, desiredFilename: string): Promise<string> {
  const nonce = Date.now().toString() + Math.random().toString().slice(2);
  const key = `md_dl_${url}_${nonce}`;
  await browser.storage.session.set({ [key]: desiredFilename });
  return key;
}

export async function unregisterFilename(key: string): Promise<void> {
  await browser.storage.session.remove(key);
}

(globalThis as any).chrome.downloads.onDeterminingFilename.addListener(
  (item: any, suggest: any) => {
    if (item.byExtensionId !== browser.runtime.id) {
      return;
    }

    let attempts = 0;
    const poll = async () => {
      // 1. Try by download ID first (most robust, requires trackDownload to have run)
      const pending = pendingDownloads.get(item.id);
      if (pending && pending.desiredFilename) {
        suggest({ filename: pending.desiredFilename, conflictAction: "uniquify" });
        return;
      }

      // 2. Try by URL from storage.session (survives Service Worker restarts)
      try {
        const data = await browser.storage.session.get(null);
        const prefix = `md_dl_${item.url}_`;
        const matchingKeys = Object.keys(data).filter((k) => k.startsWith(prefix));

        if (matchingKeys.length > 0) {
          matchingKeys.sort(); // Use oldest first
          const targetKey = matchingKeys[0];
          const desiredFilename = data[targetKey!];

          await browser.storage.session.remove(targetKey!);
          suggest({ filename: desiredFilename, conflictAction: "uniquify" });
          return;
        }
      } catch (err) {
        console.warn("[md] Storage session read failed in onDeterminingFilename", err);
      }

      // 3. Fallback polling
      if (attempts < 50) {
        attempts++;
        setTimeout(() => void poll(), 10);
      } else {
        suggest();
      }
    };

    void poll();
    return true; // Return true to indicate suggest() will be called asynchronously.
  },
);

browser.downloads.onChanged.addListener((delta) => {
  if (delta.state === undefined) return;
  const pending = pendingDownloads.get(delta.id);
  if (!pending) return;

  if (delta.state.current === "complete") {
    pendingDownloads.delete(delta.id);

    if (pending.desiredFilename) {
      browser.downloads
        .search({ id: delta.id })
        .then((results) => {
          const dl = results[0];
          if (dl && dl.filename) {
            const actualPath = dl.filename.replace(/\\/g, "/");
            const expectedSuffix = pending.desiredFilename!.replace(/\\/g, "/");
            if (!actualPath.endsWith(expectedSuffix)) {
              // Stray file detected! The browser saved it somewhere else (usually ~/Downloads).
              // Dynamic import to avoid circular dependencies if any exist.
              import("./logger")
                .then(({ appendLog }) => {
                  void appendLog(
                    "error",
                    `STRAY FILE DETECTED! Expected: .../${expectedSuffix} | Actual: ${actualPath} | Source URL: ${dl.url}`,
                    pending.jobId,
                  );
                })
                .catch(() => {});
            }
          }
        })
        .catch(() => {});
    }

    if (pending.jobId) {
      browser.downloads.erase({ id: delta.id }).catch(() => {});
    }

    pending.resolve();
  } else if (delta.state.current === "interrupted") {
    pendingDownloads.delete(delta.id);
    browser.downloads.erase({ id: delta.id }).catch(() => {});
    pending.reject(
      new Error(`download interrupted${delta.error ? `: ${delta.error.current}` : ""}`),
    );
  } else if (delta.state.current === "canceled") {
    pendingDownloads.delete(delta.id);
    browser.downloads.erase({ id: delta.id }).catch(() => {});
    pending.reject(new Error("download canceled"));
  }
});

export function trackDownload(
  downloadId: number,
  jobId: string,
  desiredFilename?: string,
  regKey?: string,
): Promise<void> {
  if (regKey) {
    void unregisterFilename(regKey);
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

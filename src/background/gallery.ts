import browser from "webextension-polyfill";
import type {
  GalleryJobItem,
  MDGalleryStartRequest,
  MDJobProgressMessage,
} from "../types/messages";
import type { DownloadJob } from "../types/jobs";
import { crossOriginFetchText } from "./fetcher";
import { appendLog } from "./logger";
import { getModel } from "../hosts/index";
import { isMediaFile, isTransientError } from "./media-util";
import { sanitizeFilename } from "./sanitize";
import { DEFAULT_SETTINGS } from "../settings/schema";

const JOBS_KEY = "downloadJobs";

// ── Download completion tracking ─────────────────────────────────────────────
// browser.downloads.download() resolves on *initiation*, not completion.
// We track each downloadId and wait for onChanged to confirm the file actually
// landed on disk — otherwise CDN errors / expired tokens silently drop files
// while the job counter reports them as "ok".
//
// No fixed timeout: a 2 GB video on a slow link can legitimately take many
// minutes. Chrome's download manager reports interrupted/canceled on its own
// for network failures, expired tokens, disk-full, etc. — those are the real
// error signals, not an arbitrary timer.

interface PendingDownload {
  resolve: () => void;
  reject: (err: Error) => void;
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

// ── Storage helpers ──────────────────────────────────────────────────────────

async function readJobs(): Promise<DownloadJob[]> {
  const stored = await browser.storage.local.get({ [JOBS_KEY]: [] });
  return (stored[JOBS_KEY] as DownloadJob[] | undefined) ?? [];
}

async function upsertJob(job: DownloadJob): Promise<void> {
  const jobs = await readJobs();
  const idx = jobs.findIndex((j) => j.jobId === job.jobId);
  if (idx >= 0) {
    jobs[idx] = job;
  } else {
    jobs.unshift(job); // newest first
    // Keep at most 50 completed jobs to avoid unbounded storage growth
    const keep = jobs
      .filter((j) => j.status === "running")
      .concat(jobs.filter((j) => j.status !== "running").slice(0, 50));
    await browser.storage.local.set({ [JOBS_KEY]: keep });
    return;
  }
  await browser.storage.local.set({ [JOBS_KEY]: jobs });
}

export async function listJobs(): Promise<DownloadJob[]> {
  return readJobs();
}

// ── Progress broadcast ───────────────────────────────────────────────────────

function broadcastProgress(job: DownloadJob): void {
  const msg: MDJobProgressMessage = {
    type: "MD_JOB_PROGRESS",
    jobId: job.jobId,
    completedCount: job.completedCount,
    totalCount: job.totalCount,
    failedCount: job.failedCount,
    status: job.status,
    items: job.items,
  };
  void browser.runtime.sendMessage(msg).catch(() => {});
  void broadcastProgressToTabs(job);
}

// ── URL resolution ───────────────────────────────────────────────────────────

// Retry transient HTTP failures (502, 503, 504, network errors) with backoff.
// Both the viewer page fetch and hoster-specific resolveUrl hooks (e.g. bunkr's
// sign API) can hit these under load.
async function fetchWithRetry(
  url: string,
  jobId: string,
  label: string,
  maxRetries = 3,
): Promise<{ text: string }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoff = 1000 * 2 ** (attempt - 1);
      void appendLog("debug", `Retry ${attempt}/${maxRetries} for ${label} in ${backoff}ms`, jobId);
      await sleep(backoff);
    }
    try {
      return await crossOriginFetchText(url);
    } catch (err) {
      lastErr = err;
      const msg = String(err);
      const transient = /HTTP\s+5\d\d/.test(msg) || /Failed to fetch|NetworkError|abort/i.test(msg);
      if (attempt < maxRetries && transient) continue;
      break;
    }
  }
  throw lastErr;
}

// Resolve a gallery item to a downloadable URL. The flow:
//   1. For "resolved" items, the URL is already known.
//   2. For "resolve-viewer" items, fetch the viewer page HTML.
//   3. If the model provides extractFromViewer, call it (owns all hoster-specific
//      parsing: regex, <source> fallbacks, maintenance detection, filename).
//   4. Otherwise, use the item's regex extractor (generic fallback).
//   5. If the model provides resolveUrl, call it (e.g. bunkr's sign API).
//   6. Otherwise, return the raw URL directly.
async function resolveItem(item: GalleryJobItem, jobId: string, hosterId: string): Promise<string> {
  if (item.kind === "resolved") return item.imageUrl;

  const model = getModel(hosterId as never);
  const gc = model?.galleryConfig;

  void appendLog("debug", `Fetching viewer: ${item.viewerUrl}`, jobId);
  const { text } = await fetchWithRetry(item.viewerUrl, jobId, "viewer page");

  let rawUrl: string | undefined;
  let filenameOverride: string | undefined;

  // Prefer the model's custom extractor (e.g. bunkr: jsCDN + <source> + maintenance).
  if (gc?.extractFromViewer) {
    const result = gc.extractFromViewer(text);
    if (result) {
      rawUrl = result.url.replace(/\\/g, "");
      filenameOverride = result.filename;
    }
  }

  // Generic fallback: regex extractor on the HTML.
  if (!rawUrl) {
    const match = new RegExp(item.extractor).exec(text);
    if (match?.[1]) {
      rawUrl = match[1].replace(/\\/g, "");
    }
  }

  if (!rawUrl) {
    void appendLog(
      "error",
      `Extractor found no match in ${item.viewerUrl} (HTML snippet: ${text.slice(0, 300).replace(/\s+/g, " ")})`,
      jobId,
    );
    throw new Error(`extractor found no match in ${item.viewerUrl}`);
  }

  if (filenameOverride) {
    item.filename = filenameOverride;
  }

  // If the model provides a URL resolver (e.g. bunkr's sign API), call it.
  if (gc?.resolveUrl) {
    void appendLog("debug", `Resolving URL: ${rawUrl}`, jobId);
    const resolved = await gc.resolveUrl(rawUrl, item.viewerUrl);
    if (typeof resolved === "string") {
      return resolved;
    }
    if (resolved.filename) {
      item.filename = resolved.filename;
    }
    return resolved.url;
  }
  return rawUrl;
}

// ── Concurrency queue ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let creatingOffscreen: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = (browser as any).offscreen.createDocument({
    url: "src/offscreen/index.html",
    reasons: ["BLOBS"],
    justification: "Fetch and download Erome media to bypass Referer check",
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function hasOffscreenDocument(): Promise<boolean> {
  if ("getContexts" in browser.runtime) {
    const contexts = await (browser.runtime as any).getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    return contexts.length > 0;
  }

  const clients = await (self as any).clients.matchAll();
  return clients.some((c: any) => c.url.includes("offscreen/index.html"));
}

async function downloadViaOffscreen(url: string, filePath: string): Promise<void> {
  await ensureOffscreenDocument();

  const response = (await browser.runtime.sendMessage({
    type: "MD_OFFSCREEN_DOWNLOAD",
    url,
  })) as { blobUrl?: string; error?: string };

  if (response && "error" in response && response.error) {
    throw new Error(response.error);
  }

  const blobUrl = response?.blobUrl;
  if (!blobUrl) {
    throw new Error("No blob URL returned from offscreen document");
  }

  try {
    const downloadId = await browser.downloads.download({
      url: blobUrl,
      filename: filePath,
      conflictAction: "uniquify",
    });

    await new Promise<void>((resolve, reject) => {
      pendingDownloads.set(downloadId, {
        resolve: () => {
          browser.runtime.sendMessage({ type: "MD_OFFSCREEN_CLEANUP", blobUrl }).catch(() => {});
          resolve();
        },
        reject: (err) => {
          browser.runtime.sendMessage({ type: "MD_OFFSCREEN_CLEANUP", blobUrl }).catch(() => {});
          reject(err);
        },
      });
    });
  } catch (err) {
    browser.runtime.sendMessage({ type: "MD_OFFSCREEN_CLEANUP", blobUrl }).catch(() => {});
    throw err;
  }
}

export async function attemptDownload(url: string, filePath: string): Promise<void> {
  if (url.includes("erome.com") && isMediaFile(filePath)) {
    return downloadViaOffscreen(url, filePath);
  }

  const downloadId = await browser.downloads.download({
    url,
    filename: filePath,
    conflictAction: "uniquify",
  });
  await new Promise<void>((resolve, reject) => {
    pendingDownloads.set(downloadId, { resolve, reject });
  });
}

// Pair each item with its original index into job.items so we can partition
// items by media type without losing track of which progress slot they own.
type QueueEntry = { item: GalleryJobItem; origIdx: number };

async function runQueue(
  job: DownloadJob,
  entries: QueueEntry[],
  maxParallel: number,
  maxRetries: number,
): Promise<void> {
  let cursor = 0;

  async function runOne(): Promise<void> {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      const item = entry.item;
      const idx = entry.origIdx;
      if (!item) continue;

      if (job.items?.[idx]) {
        job.items[idx].status = "running";
        await upsertJob(job);
        broadcastProgress(job);
      }

      let imageUrl: string;
      try {
        imageUrl = await resolveItem(item, job.jobId, job.hosterId);
      } catch (resolveErr) {
        void appendLog(
          "error",
          `Resolve failed for item ${idx + 1}: ${String(resolveErr)}`,
          job.jobId,
        );
        job.failedCount++;
        job.completedCount++;
        if (job.items?.[idx]) {
          job.items[idx].status = "error";
          job.items[idx].error = String(resolveErr);
        }
        await upsertJob(job);
        broadcastProgress(job);
        continue;
      }

      const resolvedFilename =
        item.kind === "resolve-viewer" && !item.filename.includes(".")
          ? (new URL(imageUrl).pathname.split("/").at(-1) ?? item.filename)
          : item.filename;
      const safeFilename = sanitizeFilename(resolvedFilename);
      const filePath = job.subfolder ? `${job.subfolder}/${safeFilename}` : safeFilename;

      try {
        let succeeded = false;
        let lastErr: unknown;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (attempt > 0) {
            const backoff = 1000 * 2 ** (attempt - 1);
            void appendLog(
              "debug",
              `Retry ${attempt}/${maxRetries} for ${safeFilename} in ${backoff}ms`,
              job.jobId,
            );
            await sleep(backoff);
          }
          try {
            await attemptDownload(imageUrl, filePath);
            succeeded = true;
            break;
          } catch (dlErr) {
            lastErr = dlErr;
            if (attempt < maxRetries && isTransientError(dlErr)) continue;
            break;
          }
        }

        if (succeeded) {
          job.completedCount++;
          if (job.items?.[idx]) {
            job.items[idx].status = "done";
            job.items[idx].filename = safeFilename;
          }
          void appendLog("debug", `Downloaded: ${filePath}`, job.jobId);
        } else {
          void appendLog("error", `Download failed for ${imageUrl}: ${String(lastErr)}`, job.jobId);
          job.failedCount++;
          job.completedCount++;
          if (job.items?.[idx]) {
            job.items[idx].status = "error";
            job.items[idx].error = String(lastErr);
          }
        }
      } catch (outerErr) {
        void appendLog("error", `Unexpected error for ${imageUrl}: ${String(outerErr)}`, job.jobId);
        job.failedCount++;
        job.completedCount++;
        if (job.items?.[idx]) {
          job.items[idx].status = "error";
          job.items[idx].error = String(outerErr);
        }
      }
      await upsertJob(job);
      broadcastProgress(job);
    }
  }

  const slots = Math.min(entries.length, maxParallel);
  if (slots > 0) await Promise.all(Array.from({ length: slots }, runOne));
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function startGalleryJob(req: MDGalleryStartRequest): Promise<void> {
  const job: DownloadJob = {
    jobId: req.jobId,
    hosterId: req.hosterId,
    subfolder: req.subfolder,
    totalCount: req.items.length,
    completedCount: 0,
    failedCount: 0,
    status: "running",
    startedAt: Date.now(),
    items: req.items.map((item) => ({
      displayName: item.kind === "resolve-viewer" ? item.viewerUrl : item.imageUrl,
      filename: item.filename,
      status: "pending" as const,
    })),
  };
  await upsertJob(job);
  broadcastProgress(job);

  // Partition items by media type so videos (large, CDN-throttled) get their
  // own lower-parallelism queue while images stay aggressive.
  const entries = req.items.map((item, i) => ({ item, origIdx: i }));
  const mediaEntries = entries.filter((e) => isMediaFile(e.item.filename));
  const imageEntries = entries.filter((e) => !isMediaFile(e.item.filename));

  void appendLog(
    "info",
    `Gallery job started [${req.hosterId}]: ${req.items.length} items (${imageEntries.length} img, ${mediaEntries.length} media) → "${req.subfolder || "(no folder)"}", parallel=${req.maxParallelImg}/${req.maxParallelVid}`,
    job.jobId,
  );

  // Read maxDownloadRetries from settings
  const stored = await browser.storage.local.get({
    maxDownloadRetries: DEFAULT_SETTINGS.maxDownloadRetries,
  });
  const maxRetries =
    typeof stored["maxDownloadRetries"] === "number"
      ? stored["maxDownloadRetries"]
      : DEFAULT_SETTINGS.maxDownloadRetries;

  // Run both queues concurrently — images at maxParallelImg, media at maxParallelVid.
  // Both share the same job counters; job completes when both queues drain.
  await Promise.all([
    runQueue(job, imageEntries, req.maxParallelImg, maxRetries),
    runQueue(job, mediaEntries, req.maxParallelVid, maxRetries),
  ]);

  job.status = job.failedCount > 0 ? "error" : "done";
  await upsertJob(job);
  broadcastProgress(job);
  void appendLog(
    "info",
    `Job complete: ${job.completedCount - job.failedCount} ok, ${job.failedCount} failed`,
    job.jobId,
  );
}

// Called at SW startup to recover any jobs that were interrupted by SW termination.
export async function resumeRunningJobs(): Promise<void> {
  const jobs = await readJobs();
  for (const job of jobs) {
    if (job.status === "running") {
      job.status = "error";
      await upsertJob(job);
      broadcastProgress(job);
      void appendLog("warn", "Job marked error: SW restarted mid-run", job.jobId);
    }
  }
}

async function broadcastProgressToTabs(job: DownloadJob): Promise<void> {
  const msg = {
    type: "MD_JOB_PROGRESS",
    jobId: job.jobId,
    completedCount: job.completedCount,
    totalCount: job.totalCount,
    status: job.status,
  };
  try {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        await browser.tabs.sendMessage(tab.id, msg).catch(() => {});
      }
    }
  } catch {}
}

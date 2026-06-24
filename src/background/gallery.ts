import browser from "webextension-polyfill";
import type {
  GalleryJobItem,
  MDGalleryStartRequest,
  MDJobProgressMessage,
} from "../types/messages";
import type { DownloadJob, DownloadJobItem } from "../types/jobs";
import { trackDownload } from "./download-tracker";
import {
  upsertJob,
  getJob,
  setJobUpdatedListener,
  isJobCancelled,
  findDoneItem,
} from "./job-store";
import { resolveItem } from "./item-resolver";
import { appendLog } from "./logger";
import { isMediaFile, isTransientError } from "./media-util";
import { sanitizeFilename } from "./sanitize";
import { DEFAULT_SETTINGS } from "../settings/schema";
import { getModel } from "../hosts/index";

let activeJobPromise: Promise<void> = Promise.resolve();

// ── Targeted tab broadcast ───────────────────────────────────────────────────
// Tracks which content-script tab originated each job/crawl, so progress can be
// sent to that one tab only — not every open tab via tabs.query({}). Content
// tabs need MD_JOB_PROGRESS only for terminal states (crawl cancel + button
// reset); running updates are options-page only (via runtime.sendMessage).
const jobTabIds = new Map<string, number>();

export function registerJobTab(jobId: string, tabId: number): void {
  jobTabIds.set(jobId, tabId);
}

export function unregisterJobTab(jobId: string): void {
  jobTabIds.delete(jobId);
}

// ── Progress broadcast ───────────────────────────────────────────────────────

// Counts-only broadcast — used by setJobUpdatedListener and job completion.
// Does NOT include the items array (avoids serializing 50 items per message).
function broadcastProgress(job: DownloadJob): void {
  const msg: MDJobProgressMessage = {
    type: "MD_JOB_PROGRESS",
    jobId: job.jobId,
    completedCount: job.completedCount,
    totalCount: job.totalCount,
    failedCount: job.failedCount,
    status: job.status,
  };
  void browser.runtime.sendMessage(msg).catch(() => {});
  void broadcastProgressToTabs(job);
}

// Full-state broadcast — sends the complete items array. Used once on job
// start so the options page can render all rows immediately.
function broadcastJobStart(job: DownloadJob): void {
  const msg: MDJobProgressMessage = {
    type: "MD_JOB_PROGRESS",
    jobId: job.jobId,
    completedCount: job.completedCount,
    totalCount: job.totalCount,
    failedCount: job.failedCount,
    status: job.status,
    ...(job.items ? { items: job.items } : {}),
  };
  void browser.runtime.sendMessage(msg).catch(() => {});
  void broadcastProgressToTabs(job);
}

// Per-item broadcast — sends counts + the one changed item so the options
// page can patch a single DOM row instead of rebuilding all 50.
function broadcastItemUpdate(job: DownloadJob, idx: number): void {
  const item = job.items?.[idx];
  if (!item) return;
  const msg: MDJobProgressMessage = {
    type: "MD_JOB_PROGRESS",
    jobId: job.jobId,
    completedCount: job.completedCount,
    totalCount: job.totalCount,
    failedCount: job.failedCount,
    status: job.status,
    itemDelta: {
      idx,
      status: item.status,
      filename: item.filename,
      ...(item.error ? { error: item.error } : {}),
      ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
    },
  };
  void browser.runtime.sendMessage(msg).catch(() => {});
}

async function broadcastProgressToTabs(job: DownloadJob): Promise<void> {
  // Content tabs only need terminal-state messages (crawl cancel + button
  // reset). Running updates are options-page only (via runtime.sendMessage
  // above). This eliminates the tabs.query({}) + serial sendMessage-to-all
  // storm that froze the browser during large crawls.
  if (job.status === "running") return;

  const tabId = jobTabIds.get(job.jobId);
  if (tabId === undefined) return;

  const msg = {
    type: "MD_JOB_PROGRESS" as const,
    jobId: job.jobId,
    completedCount: job.completedCount,
    totalCount: job.totalCount,
    status: job.status,
  };
  try {
    await browser.tabs.sendMessage(tabId, msg).catch(() => {
      // Tab may have closed — stop tracking it.
      jobTabIds.delete(job.jobId);
    });
  } catch {
    jobTabIds.delete(job.jobId);
  }
}

// Bind job store updates to broadcast progress
setJobUpdatedListener(broadcastProgress);

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

async function downloadViaOffscreen(url: string, filePath: string, jobId?: string): Promise<void> {
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

    await trackDownload(downloadId, jobId || "").finally(() => {
      browser.runtime.sendMessage({ type: "MD_OFFSCREEN_CLEANUP", blobUrl }).catch(() => {});
    });
  } catch (err) {
    browser.runtime.sendMessage({ type: "MD_OFFSCREEN_CLEANUP", blobUrl }).catch(() => {});
    throw err;
  }
}

export async function attemptDownload(
  url: string,
  filePath: string,
  jobId?: string,
  hosterId?: string,
): Promise<void> {
  // Check the model's offscreenForMediaFiles flag instead of hardcoding the
  // hoster's domain. The hosterId is passed from runQueue (gallery downloads);
  // single-download callers don't pass it, but offscreen-only hosters (erome)
  // don't have single-download pages anyway.
  if (hosterId) {
    const model = getModel(hosterId as any);
    if (model?.galleryConfig?.offscreenForMediaFiles && isMediaFile(filePath)) {
      return downloadViaOffscreen(url, filePath, jobId);
    }
  }

  const downloadId = await browser.downloads.download({
    url,
    filename: filePath,
    conflictAction: "uniquify",
  });
  await trackDownload(downloadId, jobId || "");
}

// Pair each item with its original index into job.items so we can partition
// items by media type without losing track of which progress slot they own.
type QueueEntry = { item: GalleryJobItem; origIdx: number };

async function runQueue(
  job: DownloadJob,
  entries: QueueEntry[],
  maxParallel: number,
  maxRetries: number,
  skipExisting: boolean,
): Promise<void> {
  let cursor = 0;

  async function runOne(): Promise<void> {
    while (cursor < entries.length) {
      if (isJobCancelled(job.jobId)) break;

      const entry = entries[cursor++];
      if (!entry) continue;
      const item = entry.item;
      const idx = entry.origIdx;

      if (job.items?.[idx]?.status === "done") {
        const displayName = item.kind === "resolve-viewer" ? item.viewerUrl : item.imageUrl;
        void appendLog("debug", `Skipped (already downloaded): ${displayName}`, job.jobId);
        continue;
      }

      if (job.items?.[idx]) {
        job.items[idx].status = "running";
        await upsertJob(job);
        broadcastItemUpdate(job, idx);
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
        broadcastItemUpdate(job, idx);
        continue;
      }

      // Check cancellation right after resolving the item
      if (isJobCancelled(job.jobId)) {
        job.status = "canceled";
        if (job.items?.[idx]) {
          job.items[idx].status = "pending";
          await upsertJob(job);
        }
        break;
      }

      const resolvedFilename =
        item.kind === "resolve-viewer" && !item.filename.includes(".")
          ? (new URL(imageUrl).pathname.split("/").at(-1) ?? item.filename)
          : item.filename;
      const safeFilename = sanitizeFilename(resolvedFilename);
      const itemSubfolder = item.subfolder ?? job.subfolder;
      const filePath = itemSubfolder ? `${itemSubfolder}/${safeFilename}` : safeFilename;

      // Skip-if-exists: check the IDB [subfolder+displayName] composite index
      // for a previously downloaded item. O(1) lookup — replaces the
      // chrome.downloads.search approach (which won't work for LO's clear-
      // history workflow). Catches duplicates within the same job and files
      // from previous jobs that the job-start dedup might have missed.
      const displayName = item.kind === "resolve-viewer" ? item.viewerUrl : item.imageUrl;
      if (skipExisting && displayName) {
        const existing = await findDoneItem(itemSubfolder, displayName);
        if (existing) {
          job.completedCount++;
          if (job.items?.[idx]) {
            job.items[idx].status = "done";
            job.items[idx].filename = existing.filename || safeFilename;
          }
          void appendLog("debug", `Skipped (exists in history): ${displayName}`, job.jobId);
          await upsertJob(job);
          broadcastItemUpdate(job, idx);
          continue;
        }
      }

      try {
        let succeeded = false;
        let lastErr: unknown;
        let isCanceled = false;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (isJobCancelled(job.jobId)) {
            job.status = "canceled";
            isCanceled = true;
            break;
          }

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
            await attemptDownload(imageUrl, filePath, job.jobId, job.hosterId);
            succeeded = true;
            break;
          } catch (dlErr) {
            lastErr = dlErr;
            if (attempt < maxRetries && isTransientError(dlErr)) continue;
            break;
          }
        }

        if (isCanceled) {
          if (job.items?.[idx]) {
            job.items[idx].status = "pending";
            await upsertJob(job);
          }
          break;
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
      broadcastItemUpdate(job, idx);
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
    originalItems: req.items,
    maxParallelImg: req.maxParallelImg,
    maxParallelVid: req.maxParallelVid,
    postedAt: req.postedAt,
    items: [],
  };

  // Dedup: for each item, check if a done item with the same [subfolder+
  // displayName] already exists in IDB. This uses the composite index — O(1)
  // per item instead of the old O(jobs × items) nested loop.
  for (let i = 0; i < req.items.length; i++) {
    const item = req.items[i];
    if (!item) continue;
    const displayName = item.kind === "resolve-viewer" ? item.viewerUrl : item.imageUrl;
    const sourceUrl =
      item.kind === "resolve-viewer" ? item.viewerUrl : (item.sourceUrl ?? item.imageUrl);

    const existing = await findDoneItem(req.subfolder, displayName);
    const result: DownloadJobItem = {
      displayName,
      filename: existing ? existing.filename : item.filename,
      status: existing ? ("done" as const) : ("pending" as const),
    };
    if (sourceUrl) result.sourceUrl = sourceUrl;
    if (job.items) {
      job.items[i] = result;
    } else {
      job.items = [result];
    }
  }

  job.completedCount = job.items?.filter((item) => item.status === "done").length ?? 0;

  await upsertJob(job);
  broadcastJobStart(job);

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

  // Read maxDownloadRetries + skipExistingFiles from settings
  const stored = await browser.storage.local.get({
    maxDownloadRetries: DEFAULT_SETTINGS.maxDownloadRetries,
    skipExistingFiles: DEFAULT_SETTINGS.skipExistingFiles,
  });
  const maxRetries =
    typeof stored["maxDownloadRetries"] === "number"
      ? stored["maxDownloadRetries"]
      : DEFAULT_SETTINGS.maxDownloadRetries;
  const skipExisting =
    typeof stored["skipExistingFiles"] === "boolean"
      ? stored["skipExistingFiles"]
      : DEFAULT_SETTINGS.skipExistingFiles;

  // Chain the execution of this job to serialize downloading.
  const myTurn = activeJobPromise
    .then(async () => {
      // Read latest status to verify it wasn't cancelled while waiting in the queue
      const latestJob = await getJob(job.jobId);
      // A job that's been cleared from storage is just as dead as one marked
      // canceled — treat "not found" as aborted so we never resurrect a cleared
      // job as "done" with zero progress (the repopulate-after-clear bug).
      if (!latestJob || latestJob.status === "canceled") {
        return;
      }

      // Run both queues concurrently — images at maxParallelImg, media at maxParallelVid.
      // Both share the same job counters; job completes when both queues drain.
      await Promise.all([
        runQueue(job, imageEntries, req.maxParallelImg, maxRetries, skipExisting),
        runQueue(job, mediaEntries, req.maxParallelVid, maxRetries, skipExisting),
      ]);

      // Read latest job status from storage to see if it was cancelled
      const latestJobAfter = await getJob(job.jobId);
      // Not-found = cleared by the user mid-run. Don't resurrect it as "done".
      if (!latestJobAfter || latestJobAfter.status === "canceled") {
        void appendLog(
          "info",
          `Job stopped by user: ${job.completedCount} completed, ${job.failedCount} failed`,
          job.jobId,
        );
        return;
      }

      job.status = job.failedCount > 0 ? "error" : "done";
      // Done jobs can't be resumed (resumeJob only accepts canceled/error),
      // so originalItems is pure waste. Trim it to reduce storage payload.
      // Error/canceled jobs keep originalItems for resume.
      if (job.status === "done") {
        job.originalItems = undefined;
      }
      await upsertJob(job);
      broadcastProgress(job);
      void appendLog(
        "info",
        `Job complete: ${job.completedCount - job.failedCount} ok, ${job.failedCount} failed`,
        job.jobId,
      );
    })
    .catch((err) => {
      console.error(`[md] Error running queued job ${job.jobId}:`, err);
    })
    .finally(() => {
      unregisterJobTab(job.jobId);
    });

  activeJobPromise = myTurn;
  await myTurn;
}

// ── Crawl phase ──────────────────────────────────────────────────────────────
// A crawl job is a visible, cancellable placeholder that tracks the
// girlsreleased listing → per-set resolution BEFORE any download starts. The
// MAIN world posts MD_CRAWL_START → streams MD_CRAWL_PROGRESS → ends with
// MD_CRAWL_DONE. Only if the crawl completes un-aborted does it post the
// MD_GALLERY_START burst for each resolved set. Cancelling the crawl job (via
// Stop All or the crawl card's Stop) aborts the in-flight set fetches in the
// content script and suppresses the download burst entirely.

export async function startCrawlJob(req: {
  crawlId: string;
  hosterId: string;
  albumName: string;
  setCount: number;
}): Promise<void> {
  const job: DownloadJob = {
    jobId: req.crawlId,
    hosterId: req.hosterId as DownloadJob["hosterId"],
    subfolder: req.albumName,
    totalCount: req.setCount,
    completedCount: 0,
    failedCount: 0,
    status: "running",
    startedAt: Date.now(),
    isCrawl: true,
  };
  await upsertJob(job);
  broadcastProgress(job);
  void appendLog(
    "info",
    `Crawl started [${req.hosterId}]: resolving ${req.setCount} sets from "${req.albumName}"`,
    req.crawlId,
  );
}

export async function updateCrawlProgress(req: {
  crawlId: string;
  resolvedCount: number;
  failedCount: number;
  setCount: number;
}): Promise<void> {
  const job = await getJob(req.crawlId);
  if (!job || job.status !== "running") return; // cancelled/gone — drop update
  job.completedCount = req.resolvedCount + req.failedCount;
  job.failedCount = req.failedCount;
  job.totalCount = req.setCount;
  await upsertJob(job);
  broadcastProgress(job);
}

export async function finishCrawlJob(req: { crawlId: string; aborted: boolean }): Promise<void> {
  const job = await getJob(req.crawlId);
  if (!job) {
    unregisterJobTab(req.crawlId);
    return; // already cleared
  }
  if (req.aborted) {
    if (job.status === "running") {
      job.status = "canceled";
      await upsertJob(job);
      broadcastProgress(job);
    }
    unregisterJobTab(req.crawlId);
    void appendLog("warn", "Crawl aborted by user — no downloads started", req.crawlId);
    return;
  }
  job.status = job.failedCount > 0 ? "error" : "done";
  await upsertJob(job);
  broadcastProgress(job);
  unregisterJobTab(req.crawlId);
  void appendLog(
    "info",
    `Crawl complete: ${job.completedCount - job.failedCount} sets resolved, ${job.failedCount} failed — posting download jobs`,
    req.crawlId,
  );
}

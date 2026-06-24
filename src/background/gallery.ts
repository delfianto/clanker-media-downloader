import browser from "webextension-polyfill";
import type {
  GalleryJobItem,
  MDGalleryStartRequest,
  MDJobProgressMessage,
} from "../types/messages";
import type { DownloadJob, DownloadJobItem } from "../types/jobs";
import { trackDownload, preRegisterFilename, unregisterFilename } from "./download-tracker";
import {
  upsertJob,
  upsertJobItem,
  insertJobItems,
  getJob,
  setJobUpdatedListener,
  isJobCancelled,
  findDoneItem,
} from "./job-store";
import { resolveItem } from "./item-resolver";
import { jobActivityBegin, jobActivityEnd } from "./download-ui";
import { ensureOffscreenDocument } from "./offscreen";
import { appendLog } from "./logger";
import { isMediaFile, isTransientError, classifyFailure, failureLabel } from "./media-util";
import { sanitizeFilename } from "./sanitize";
import { DEFAULT_SETTINGS } from "../settings/schema";
import { getModel } from "../hosts/index";

// Maintain a single sequential queue for all download jobs. They will be
// processed strictly in the order they are started.
let activeJobPromise = Promise.resolve();

// Maintain a single sequential queue for job setups to prevent massive
// concurrent IDB transactions when a crawl fires 50+ jobs simultaneously.
let setupPromiseQueue = Promise.resolve();

// Strictly-increasing timestamp to preserve FIFO download order in History list during crawl bursts.
let lastStartedAt = 0;
function nextStartedAt(): number {
  const now = Date.now();
  lastStartedAt = now > lastStartedAt ? now : lastStartedAt + 1;
  return lastStartedAt;
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
  // Send only terminal-state messages to all tabs to ensure the originating
  // tab receives it even if the Service Worker restarted and lost memory state.
  if (job.status === "running") return;

  const msg = {
    type: "MD_JOB_PROGRESS" as const,
    jobId: job.jobId,
    completedCount: job.completedCount,
    totalCount: job.totalCount,
    status: job.status,
  };

  try {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        // Ignore errors for tabs without the content script injected
        void browser.tabs.sendMessage(tab.id, msg).catch(() => {});
      }
    }
  } catch {
    // Ignore permissions errors
  }
}

// Bind job store updates to broadcast progress
setJobUpdatedListener(broadcastProgress);

// ── Concurrency queue ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Offscreen logic moved to offscreen.ts

async function downloadViaOffscreen(url: string, filePath: string, jobId?: string): Promise<void> {
  // Adopt existing in-progress downloads to survive SW restarts
  const inProgress = await browser.downloads.search({ state: "in_progress" });
  const orphaned = inProgress.find((d) => d.filename.replace(/\\/g, "/").endsWith(filePath));
  if (orphaned) {
    void appendLog("debug", `Adopting orphaned offscreen download for ${filePath}`, jobId || "");
    await trackDownload(orphaned.id, jobId || "", filePath);
    return;
  }

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

    await trackDownload(downloadId, jobId || "", filePath).finally(() => {
      browser.runtime.sendMessage({ type: "MD_OFFSCREEN_CLEANUP", blobUrl }).catch(() => {});
    });
  } catch (err) {
    browser.runtime.sendMessage({ type: "MD_OFFSCREEN_CLEANUP", blobUrl }).catch(() => {});
    throw err;
  }
}

async function precheckDownloadUrl(url: string): Promise<void> {
  if (!url.startsWith("http")) return;

  try {
    const res = await fetch(url, { method: "HEAD", credentials: "include" });
    if (res.status === 405) return; // Method Not Allowed, fallback to native

    // If it's a 4xx or 5xx, throw early so we don't pollute the Chrome Downloads UI
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    // Prevent Chrome from downloading 200 OK HTML error pages and dumping them into ~/Downloads.
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      throw new Error("Server returned HTML page instead of image (dead link or block)");
    }
  } catch (err) {
    // If the error was explicitly thrown by our checks above, rethrow it.
    if (
      err instanceof Error &&
      (err.message.startsWith("HTTP ") || err.message.includes("HTML page"))
    ) {
      throw err;
    }
    // Ignore CORS/network errors and let native downloader handle them.
  }
}

export async function attemptDownload(
  url: string,
  filePath: string,
  jobId?: string,
  hosterId?: string,
): Promise<void> {
  if (hosterId) {
    const model = getModel(hosterId as any);
    if (model?.galleryConfig?.offscreenForMediaFiles && isMediaFile(filePath)) {
      return downloadViaOffscreen(url, filePath, jobId);
    }
  }

  // Adopt existing in-progress downloads to survive SW restarts
  const inProgress = await browser.downloads.search({ state: "in_progress" });
  // Check either URL match or absolute filename ending with our relative path
  const orphaned = inProgress.find(
    (d) => d.url === url || d.filename.replace(/\\/g, "/").endsWith(filePath),
  );
  if (orphaned) {
    void appendLog("debug", `Adopting orphaned native download for ${filePath}`, jobId || "");
    await trackDownload(orphaned.id, jobId || "", filePath, orphaned.url);
    return;
  }

  await precheckDownloadUrl(url);

  // Pre-register the URL -> filename mapping before creating the download.
  // This fixes the Chrome MV3 race condition where onDeterminingFilename fires
  // *before* downloads.download resolves with its downloadId.
  preRegisterFilename(url, filePath);

  try {
    const downloadId = await browser.downloads.download({
      url,
      filename: filePath,
      conflictAction: "uniquify",
    });
    await trackDownload(downloadId, jobId || "", filePath, url);
  } catch (err) {
    unregisterFilename(url, filePath);
    throw err;
  }
}

// Pair each item with its original index into job.items so we can partition
// items by media type without losing track of which progress slot they own.
type QueueEntry = { item: GalleryJobItem; origIdx: number };

async function createSubfolder(subfolder: string): Promise<void> {
  try {
    const downloadId = await browser.downloads.download({
      url: "data:text/plain;base64,",
      filename: `${subfolder}/.md-keep`,
      conflictAction: "overwrite",
    });
    // Wait for the native file write to finish so the directory is guaranteed to exist
    await trackDownload(downloadId, "");
    // Clean up the placeholder file and its history entry silently
    await browser.downloads.removeFile(downloadId).catch(() => {});
    await browser.downloads.erase({ id: downloadId }).catch(() => {});
  } catch (err) {
    console.warn(`[md] createSubfolder failed for ${subfolder}:`, err);
  }
}

async function runQueue(
  job: DownloadJob,
  entries: QueueEntry[],
  maxParallel: number,
  maxRetries: number,
  skipExisting: boolean,
): Promise<void> {
  if (job.subfolder && entries.length > 0) {
    // Pre-create the directory to bypass a Chromium Linux bug where concurrent
    // downloads to a new directory trigger a mkdir race condition, dropping files into ~/Downloads.
    await createSubfolder(job.subfolder);
  }

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
        await upsertJobItem(job, idx);
        broadcastItemUpdate(job, idx);
      }

      let imageUrl: string;
      try {
        imageUrl = await resolveItem(item, job.jobId, job.hosterId);
      } catch (resolveErr) {
        void appendLog(
          "error",
          `Resolve failed (${classifyFailure(resolveErr)}) for item ${idx + 1}: ${String(resolveErr)}`,
          job.jobId,
        );
        job.failedCount++;
        job.completedCount++;
        if (job.items?.[idx]) {
          job.items[idx].status = "error";
          job.items[idx].error = failureLabel(resolveErr);
        }
        await upsertJobItem(job, idx);
        broadcastItemUpdate(job, idx);
        continue;
      }

      // Check cancellation right after resolving the item
      if (isJobCancelled(job.jobId)) {
        job.status = "canceled";
        if (job.items?.[idx]) {
          job.items[idx].status = "pending";
          await upsertJobItem(job, idx);
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

      // Skip-if-exists: O(1) IDB lookup to prevent re-downloading files that exist in history.
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
          await upsertJobItem(job, idx);
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
            await upsertJobItem(job, idx);
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
          void appendLog(
            "error",
            `Download failed (${classifyFailure(lastErr)}) for ${imageUrl}: ${String(lastErr)}`,
            job.jobId,
          );
          job.failedCount++;
          job.completedCount++;
          if (job.items?.[idx]) {
            job.items[idx].status = "error";
            job.items[idx].error = failureLabel(lastErr);
          }
        }
      } catch (outerErr) {
        void appendLog("error", `Unexpected error for ${imageUrl}: ${String(outerErr)}`, job.jobId);
        job.failedCount++;
        job.completedCount++;
        if (job.items?.[idx]) {
          job.items[idx].status = "error";
          job.items[idx].error = failureLabel(outerErr);
        }
      }
      await upsertJobItem(job, idx);
      broadcastItemUpdate(job, idx);
    }
  }

  const slots = Math.min(entries.length, maxParallel);
  if (slots > 0) {
    await Promise.all(Array.from({ length: slots }, () => runOne()));
  }
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
    startedAt: nextStartedAt(),
    originalItems: req.items,
    maxParallelImg: req.maxParallelImg,
    maxParallelVid: req.maxParallelVid,
    postedAt: req.postedAt,
    items: [],
  };

  // Eagerly run setup but QUEUE it sequentially! When a crawl fires 50 jobs
  // at once, doing 5000 IDB transactions concurrently crashes the Service Worker
  // due to OOM. By chaining setup operations sequentially, we serialize IDB access.
  const setup = new Promise<any>((resolve) => {
    setupPromiseQueue = setupPromiseQueue
      .then(async () => {
        // Dedup: for each item, check if a done item with the same [subfolder+
        // displayName] already exists in IDB. Composite index — O(1) per item.
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
        await insertJobItems(job);
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

        resolve({ imageEntries, mediaEntries, maxRetries, skipExisting });
      })
      .catch((err) => {
        void appendLog("error", `Job setup crashed: ${String(err)}`, job.jobId);
      });
  });

  // Mark download activity active: suppresses Chrome's native download UI and
  // bumps the toolbar badge. Paired with jobActivityEnd() in the .finally below.
  jobActivityBegin();

  // Reserve this job's place in the download queue SYNCHRONOUSLY — before any
  // await — so jobs download in the exact order their MD_GALLERY_START arrived
  // (which the crawl posts in list/sort order), NOT in the order their async
  // setup happens to finish. Setup time scales with item count + IDB latency, so
  // chaining after it let a small late job jump ahead of a big early one. This is
  // the true-FIFO fix: topmost in the list runs first.
  const myTurn = activeJobPromise
    .then(async () => {
      const { imageEntries, mediaEntries, maxRetries, skipExisting } = await setup;

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
      jobActivityEnd();
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
    startedAt: nextStartedAt(),
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
    return; // already cleared
  }
  if (req.aborted) {
    if (job.status === "running") {
      job.status = "canceled";
      await upsertJob(job);
      broadcastProgress(job);
    }
    void appendLog("warn", "Crawl aborted by user — no downloads started", req.crawlId);
    return;
  }
  job.status = job.failedCount > 0 ? "error" : "done";
  await upsertJob(job);
  broadcastProgress(job);
  void appendLog(
    "info",
    `Crawl complete: ${job.completedCount - job.failedCount} sets resolved, ${job.failedCount} failed — posting download jobs`,
    req.crawlId,
  );
}

import browser from "webextension-polyfill";
import type {
  GalleryJobItem,
  MDGalleryStartRequest,
  MDJobProgressMessage,
} from "../types/messages";
import type { DownloadJob, DownloadJobItem } from "../types/jobs";
import { trackDownload } from "./download-tracker";
import { upsertJob, readJobs, setJobUpdatedListener } from "./job-store";
import { resolveItem } from "./item-resolver";
import { appendLog } from "./logger";
import { isMediaFile, isTransientError } from "./media-util";
import { sanitizeFilename } from "./sanitize";
import { DEFAULT_SETTINGS } from "../settings/schema";
import { getModel } from "../hosts/index";

let activeJobPromise: Promise<void> = Promise.resolve();

// ── Progress broadcast ───────────────────────────────────────────────────────

function broadcastProgress(job: DownloadJob): void {
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
): Promise<void> {
  let cursor = 0;

  async function runOne(): Promise<void> {
    while (cursor < entries.length) {
      const currentJobs = await readJobs();
      const currentJob = currentJobs.find((j) => j.jobId === job.jobId);
      if (!currentJob || currentJob.status === "canceled") {
        break;
      }

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

      // Check cancellation right after resolving the item
      const currentJobsCheck = await readJobs();
      const currentJobCheck = currentJobsCheck.find((j) => j.jobId === job.jobId);
      if (!currentJobCheck || currentJobCheck.status === "canceled") {
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

      try {
        let succeeded = false;
        let lastErr: unknown;
        let isCanceled = false;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          const jobsCheck = await readJobs();
          const jobCheck = jobsCheck.find((j) => j.jobId === job.jobId);
          if (!jobCheck || jobCheck.status === "canceled") {
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
      broadcastProgress(job);
    }
  }

  const slots = Math.min(entries.length, maxParallel);
  if (slots > 0) await Promise.all(Array.from({ length: slots }, runOne));
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function startGalleryJob(req: MDGalleryStartRequest): Promise<void> {
  const historyJobs = await readJobs();

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
    items: req.items.map((item) => {
      const displayName = item.kind === "resolve-viewer" ? item.viewerUrl : item.imageUrl;
      // The hoster/viewer page URL for the Downloads tab's "click to verify"
      // link. For resolve-viewer items this is the viewerUrl itself; for
      // resolved items, prefer the explicit sourceUrl (set by aggregators like
      // girlsreleased that know the original page), falling back to the image
      // URL so non-aggregator hosters still get a clickable link.
      const sourceUrl =
        item.kind === "resolve-viewer" ? item.viewerUrl : (item.sourceUrl ?? item.imageUrl);
      let alreadyDownloaded = false;
      let historicalFilename = "";

      for (const hj of historyJobs) {
        if (hj.subfolder !== req.subfolder) continue;
        const matched = hj.items?.find(
          (hi) => hi.displayName === displayName && hi.status === "done",
        );
        if (matched) {
          alreadyDownloaded = true;
          historicalFilename = matched.filename;
          break;
        }
      }

      const result: DownloadJobItem = {
        displayName,
        filename: historicalFilename || item.filename,
        status: alreadyDownloaded ? ("done" as const) : ("pending" as const),
      };
      if (sourceUrl) result.sourceUrl = sourceUrl;
      return result;
    }),
  };

  job.completedCount = job.items?.filter((item) => item.status === "done").length ?? 0;

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

  // Chain the execution of this job to serialize downloading.
  const myTurn = activeJobPromise
    .then(async () => {
      // Read latest status to verify it wasn't cancelled while waiting in the queue
      const latestJobs = await readJobs();
      const latestJob = latestJobs.find((j) => j.jobId === job.jobId);
      // A job that's been cleared from storage is just as dead as one marked
      // canceled — treat "not found" as aborted so we never resurrect a cleared
      // job as "done" with zero progress (the repopulate-after-clear bug).
      if (!latestJob || latestJob.status === "canceled") {
        return;
      }

      // Run both queues concurrently — images at maxParallelImg, media at maxParallelVid.
      // Both share the same job counters; job completes when both queues drain.
      await Promise.all([
        runQueue(job, imageEntries, req.maxParallelImg, maxRetries),
        runQueue(job, mediaEntries, req.maxParallelVid, maxRetries),
      ]);

      // Read latest job status from storage to see if it was cancelled
      const latestJobsAfter = await readJobs();
      const latestJobAfter = latestJobsAfter.find((j) => j.jobId === job.jobId);
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
  const jobs = await readJobs();
  const idx = jobs.findIndex((j) => j.jobId === req.crawlId);
  const job = jobs[idx];
  if (!job || job.status !== "running") return; // cancelled/gone — drop update
  job.completedCount = req.resolvedCount + req.failedCount;
  job.failedCount = req.failedCount;
  job.totalCount = req.setCount;
  await upsertJob(job);
  broadcastProgress(job);
}

export async function finishCrawlJob(req: { crawlId: string; aborted: boolean }): Promise<void> {
  const jobs = await readJobs();
  const idx = jobs.findIndex((j) => j.jobId === req.crawlId);
  const job = jobs[idx];
  if (!job) return; // already cleared
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

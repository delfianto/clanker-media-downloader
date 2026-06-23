import browser from "webextension-polyfill";
import type {
  GalleryJobItem,
  MDGalleryStartRequest,
  MDJobProgressMessage,
} from "../types/messages";
import type { DownloadJob } from "../types/jobs";
import { crossOriginFetchText } from "./fetcher";
import { appendLog } from "./logger";

const JOBS_KEY = "downloadJobs";

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
  };
  void browser.runtime.sendMessage(msg).catch(() => {});
}

// ── URL resolution ───────────────────────────────────────────────────────────

async function signBunkrUrl(jsCDN: string, jobId: string): Promise<string> {
  const parsed = new URL(jsCDN);
  const signUrl = `https://glb-apisign.cdn.cr/sign?path=${encodeURIComponent(parsed.pathname)}`;
  void appendLog("debug", `Signing bunkr URL: ${jsCDN}`, jobId);
  const { text } = await crossOriginFetchText(signUrl);
  const json = JSON.parse(text) as { token?: string; ex?: string };
  if (!json.token || !json.ex) throw new Error("bunkr sign API returned unexpected shape");
  return `${jsCDN}?token=${json.token}&ex=${json.ex}`;
}

async function resolveItem(item: GalleryJobItem, jobId: string): Promise<string> {
  if (item.kind === "resolved") return item.imageUrl;

  void appendLog("debug", `Fetching viewer: ${item.viewerUrl}`, jobId);
  const { text } = await crossOriginFetchText(item.viewerUrl);
  const match = new RegExp(item.extractor).exec(text);
  const rawUrl = match?.[1];
  if (!rawUrl) {
    // Log a snippet of the fetched HTML to help debug extractor mismatches.
    void appendLog(
      "error",
      `Extractor "${item.extractor}" found no match in ${item.viewerUrl} (HTML snippet: ${text.slice(0, 300).replace(/\s+/g, " ")})`,
      jobId,
    );
    throw new Error(`extractor found no match in ${item.viewerUrl}`);
  }

  if (item.needsSign) return signBunkrUrl(rawUrl, jobId);
  return rawUrl;
}

// ── Concurrency queue ────────────────────────────────────────────────────────

async function runQueue(
  job: DownloadJob,
  items: GalleryJobItem[],
  maxParallel: number,
): Promise<void> {
  let cursor = 0;

  async function runOne(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      if (!item) continue;

      void appendLog(
        "debug",
        `Item ${idx + 1}/${items.length}: ${item.kind === "resolved" ? item.imageUrl : item.viewerUrl}`,
        job.jobId,
      );

      let imageUrl: string;
      try {
        imageUrl = await resolveItem(item, job.jobId);
      } catch (resolveErr) {
        void appendLog(
          "error",
          `Resolve failed for item ${idx + 1}: ${String(resolveErr)}`,
          job.jobId,
        );
        job.failedCount++;
        job.completedCount++;
        await upsertJob(job);
        broadcastProgress(job);
        continue;
      }

      // For resolve-viewer items, derive filename from the resolved imageUrl
      // if the item's filename does not contain a file extension. For resolved items,
      // or if item.filename already has the correct basename, keep it.
      const resolvedFilename =
        item.kind === "resolve-viewer" && !item.filename.includes(".")
          ? (new URL(imageUrl).pathname.split("/").at(-1) ?? item.filename)
          : item.filename;
      const filePath = job.subfolder ? `${job.subfolder}/${resolvedFilename}` : resolvedFilename;

      try {
        await browser.downloads.download({
          url: imageUrl,
          filename: filePath,
          conflictAction: "uniquify",
        });
        job.completedCount++;
        void appendLog("debug", `Queued download: ${filePath}`, job.jobId);
      } catch (dlErr) {
        void appendLog(
          "error",
          `browser.downloads.download failed for ${imageUrl}: ${String(dlErr)}`,
          job.jobId,
        );
        job.failedCount++;
        job.completedCount++;
      }
      await upsertJob(job);
      broadcastProgress(job);
    }
  }

  const slots = Math.min(job.totalCount, maxParallel);
  await Promise.all(Array.from({ length: slots }, runOne));

  job.status = job.failedCount > 0 ? "error" : "done";
  await upsertJob(job);
  broadcastProgress(job);
  void appendLog(
    "info",
    `Job complete: ${job.completedCount - job.failedCount} ok, ${job.failedCount} failed`,
    job.jobId,
  );
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
  };
  await upsertJob(job);
  broadcastProgress(job);
  void appendLog(
    "info",
    `Gallery job started [${req.hosterId}]: ${req.items.length} items → "${req.subfolder || "(no folder)"}", parallel=${req.maxParallel}`,
    job.jobId,
  );
  // Awaiting runQueue keeps the message handler's Promise pending, which tells
  // Chrome to keep the SW alive until all downloads are initiated.
  await runQueue(job, req.items.slice(), req.maxParallel);
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

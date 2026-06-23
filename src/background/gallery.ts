import browser from "webextension-polyfill";
import type {
  GalleryJobItem,
  MDGalleryStartRequest,
  MDJobProgressMessage,
} from "../types/messages";
import type { DownloadJob } from "../types/jobs";
import { crossOriginFetchText } from "./fetcher";

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
  // Fire-and-forget to all extension pages (options, popup). Ignore errors when
  // no listener is open.
  void browser.runtime.sendMessage(msg).catch(() => {});
}

// ── URL resolution ───────────────────────────────────────────────────────────

// For bunkr: extract the signed URL via the CDN sign API.
// jsCDN is the raw (unsigned) CDN URL embedded in the viewer page source.
async function signBunkrUrl(jsCDN: string): Promise<string> {
  const parsed = new URL(jsCDN);
  const signUrl = `https://glb-apisign.cdn.cr/sign?path=${encodeURIComponent(parsed.pathname)}`;
  const { text } = await crossOriginFetchText(signUrl);
  const json = JSON.parse(text) as { token?: string; ex?: string };
  if (!json.token || !json.ex) throw new Error("bunkr sign API returned unexpected shape");
  return `${jsCDN}?token=${json.token}&ex=${json.ex}`;
}

async function resolveItem(item: GalleryJobItem): Promise<string> {
  if (item.kind === "resolved") return item.imageUrl;

  const { text } = await crossOriginFetchText(item.viewerUrl);
  const match = new RegExp(item.extractor).exec(text);
  const rawUrl = match?.[1];
  if (!rawUrl) throw new Error(`extractor found no match in ${item.viewerUrl}`);

  if (item.needsSign) return signBunkrUrl(rawUrl);
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

      const filename = item.filename;
      const filePath = job.subfolder ? `${job.subfolder}/${filename}` : filename;

      let imageUrl: string;
      try {
        imageUrl = await resolveItem(item);
      } catch {
        job.failedCount++;
        job.completedCount++;
        await upsertJob(job);
        broadcastProgress(job);
        continue;
      }

      try {
        await browser.downloads.download({
          url: imageUrl,
          filename: filePath,
          conflictAction: "uniquify",
        });
        job.completedCount++;
      } catch {
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
  void runQueue(job, req.items.slice(), req.maxParallel);
}

// Called at SW startup to recover any jobs that were interrupted by SW termination.
// In practice, MV3 SWs can be killed mid-job; this ensures the job is marked as
// errored rather than stuck forever in "running".
export async function resumeRunningJobs(): Promise<void> {
  const jobs = await readJobs();
  for (const job of jobs) {
    if (job.status === "running") {
      job.status = "error";
      await upsertJob(job);
      broadcastProgress(job);
    }
  }
}

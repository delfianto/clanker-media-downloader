import browser from "webextension-polyfill";
import type { DownloadJob } from "../types/jobs";
import type { MDGalleryStartRequest } from "../types/messages";
import { DEFAULT_SETTINGS } from "../settings/schema";
import { appendLog } from "./logger";
import { cancelActiveDownloads } from "./download-tracker";

const JOBS_KEY = "downloadJobs";

let storagePromise: Promise<any> = Promise.resolve();

export async function runInStorageQueue<T>(fn: () => Promise<T>): Promise<T> {
  const myTurn = storagePromise.then(fn);
  storagePromise = myTurn.catch(() => {});
  return myTurn;
}

export async function readJobs(): Promise<DownloadJob[]> {
  const stored = await browser.storage.local.get({ [JOBS_KEY]: [] });
  return (stored[JOBS_KEY] as DownloadJob[] | undefined) ?? [];
}

export let onJobUpdated: ((job: DownloadJob) => void) | null = null;

export function setJobUpdatedListener(listener: (job: DownloadJob) => void): void {
  onJobUpdated = listener;
}

export async function upsertJob(job: DownloadJob): Promise<void> {
  return runInStorageQueue(async () => {
    const jobs = await readJobs();
    const idx = jobs.findIndex((j) => j.jobId === job.jobId);
    if (idx >= 0) {
      const existing = jobs[idx];
      if (existing && existing.status === "canceled") {
        job.status = "canceled";
      }
      jobs[idx] = job;
    } else {
      jobs.unshift(job); // newest first
      // Keep at most 50 completed jobs to avoid unbounded storage growth
      const keep = jobs
        .filter((j) => j.status === "running")
        .concat(jobs.filter((j) => j.status !== "running").slice(0, 50));
      await browser.storage.local.set({ [JOBS_KEY]: keep });
      if (onJobUpdated) {
        onJobUpdated(job);
      }
      return;
    }
    await browser.storage.local.set({ [JOBS_KEY]: jobs });
    if (onJobUpdated) {
      onJobUpdated(job);
    }
  });
}

export async function listJobs(): Promise<DownloadJob[]> {
  const jobs = await readJobs();
  return jobs.sort((a, b) => a.startedAt - b.startedAt);
}

export async function deleteJob(jobId: string): Promise<void> {
  return runInStorageQueue(async () => {
    const jobs = await readJobs();
    const filtered = jobs.filter((j) => j.jobId !== jobId);
    await browser.storage.local.set({ [JOBS_KEY]: filtered });
  });
}

export async function cancelJob(jobId: string): Promise<void> {
  return runInStorageQueue(async () => {
    const jobs = await readJobs();
    const idx = jobs.findIndex((j) => j.jobId === jobId);
    const job = jobs[idx];
    if (job && job.status === "running") {
      job.status = "canceled";
      jobs[idx] = job;
      await browser.storage.local.set({ [JOBS_KEY]: jobs });

      // Cancel all active downloads in browser for this job
      cancelActiveDownloads(jobId);

      if (onJobUpdated) {
        onJobUpdated(job);
      }
      void appendLog("warn", "Job cancelled by user", jobId);
    }
  });
}

export async function cancelAllJobs(): Promise<void> {
  return runInStorageQueue(async () => {
    const jobs = await readJobs();
    let changed = false;
    for (const job of jobs) {
      if (job.status === "running") {
        job.status = "canceled";
        changed = true;

        // Cancel all active downloads in browser for this job
        cancelActiveDownloads(job.jobId);

        if (onJobUpdated) {
          onJobUpdated(job);
        }
        void appendLog("warn", "Job cancelled by user (global stop)", job.jobId);
      }
    }
    if (changed) {
      await browser.storage.local.set({ [JOBS_KEY]: jobs });
    }
  });
}

export async function resumeJob(
  jobId: string,
  onStartJob: (req: MDGalleryStartRequest) => void,
): Promise<void> {
  return runInStorageQueue(async () => {
    const jobs = await readJobs();
    const idx = jobs.findIndex((j) => j.jobId === jobId);
    const job = jobs[idx];
    if (job && (job.status === "canceled" || job.status === "error")) {
      const req: MDGalleryStartRequest = {
        type: "MD_GALLERY_START",
        jobId: job.jobId,
        hosterId: job.hosterId,
        subfolder: job.subfolder,
        items: job.originalItems || [],
        maxParallelImg: job.maxParallelImg ?? DEFAULT_SETTINGS.maxParallelImg,
        maxParallelVid: job.maxParallelVid ?? DEFAULT_SETTINGS.maxParallelVid,
        postedAt: job.postedAt,
      };

      job.status = "running";
      job.startedAt = Date.now(); // reset started time so it's fresh
      jobs[idx] = job;
      await browser.storage.local.set({ [JOBS_KEY]: jobs });

      if (onJobUpdated) {
        onJobUpdated(job);
      }

      setTimeout(() => {
        onStartJob(req);
      }, 0);
    }
  });
}

export async function resumeAllJobs(
  onStartJob: (req: MDGalleryStartRequest) => void,
): Promise<void> {
  const jobs = await readJobs();
  for (const job of jobs) {
    if (job.status === "canceled" || job.status === "error") {
      void resumeJob(job.jobId, onStartJob).catch(() => {});
    }
  }
}

export async function resumeRunningJobs(): Promise<void> {
  return runInStorageQueue(async () => {
    const jobs = await readJobs();
    let changed = false;
    for (const job of jobs) {
      if (job.status === "running") {
        job.status = "error";
        changed = true;

        if (onJobUpdated) {
          onJobUpdated(job);
        }
        void appendLog("warn", "Job marked error: SW restarted mid-run", job.jobId);
      }
    }
    if (changed) {
      await browser.storage.local.set({ [JOBS_KEY]: jobs });
    }
  });
}

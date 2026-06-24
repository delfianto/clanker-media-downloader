import browser from "webextension-polyfill";
import type { DownloadJob, DownloadJobItem } from "../types/jobs";
import type { MDGalleryStartRequest } from "../types/messages";
import { DEFAULT_SETTINGS } from "../settings/schema";
import { appendLog } from "./logger";
import { cancelActiveDownloads } from "./download-tracker";
import {
  openDB,
  idbGetJob,
  idbGetAllJobs,
  idbPutJob,
  idbDeleteJob,
  idbClearAllJobs,
  idbPutJobItem,
  idbGetJobItems,
  idbDeleteJobItems,
  idbClearAllJobItems,
  idbFindDoneItem,
  idbGcCompletedJobs,
  type DownloadJobRecord,
  type JobItemRecord,
} from "./idb";

// Legacy storage key — used only for one-time migration on SW startup.
const LEGACY_JOBS_KEY = "downloadJobs";

// ── In-memory cancel cache ───────────────────────────────────────────────────
// Per-item cancel checks in runQueue used to call readJobs() (deserializing ALL
// 101 jobs × ~100 objects) 3× per item — ~150M object ops during a 101-gallery
// crawl. This Set replaces those reads with an O(1) lookup. Populated by
// cancelJob/cancelAllJobs/clearAllJobs/deleteJob, cleared by resumeJob. Lost on
// SW restart, which is fine: resumeRunningJobs() marks all "running" jobs as
// "error" on restart, so no queue is alive to check the cache.
const cancelledJobs = new Set<string>();

export function isJobCancelled(jobId: string): boolean {
  return cancelledJobs.has(jobId);
}

function cancelJobInCache(jobId: string): void {
  cancelledJobs.add(jobId);
}

function uncancelJobInCache(jobId: string): void {
  cancelledJobs.delete(jobId);
}

// ── Migration: storage.local → IDB ───────────────────────────────────────────
// One-time pass on SW startup. Idempotent — skips if IDB already has data.
export async function migrateJobsIfNeeded(): Promise<void> {
  const db = await openDB();
  const count = await new Promise<number>((resolve, reject) => {
    const req = db.transaction("jobs", "readonly").objectStore("jobs").count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (count > 0) return; // already migrated

  const raw = await browser.storage.local.get({ [LEGACY_JOBS_KEY]: [] });
  const legacyJobs = (raw[LEGACY_JOBS_KEY] as DownloadJob[] | undefined) ?? [];
  if (legacyJobs.length === 0) return; // fresh install

  console.log(`[md] Migrating ${legacyJobs.length} jobs from storage.local to IDB…`);
  const db2 = await openDB();
  const tx = db2.transaction(["jobs", "jobItems"], "readwrite");
  const jobStore = tx.objectStore("jobs");
  const itemStore = tx.objectStore("jobItems");

  for (const job of legacyJobs) {
    // Write job record (without items — those go to jobItems store)
    const record: DownloadJobRecord = {
      jobId: job.jobId,
      hosterId: job.hosterId,
      subfolder: job.subfolder,
      totalCount: job.totalCount,
      completedCount: job.completedCount,
      failedCount: job.failedCount,
      status: job.status,
      startedAt: job.startedAt,
      ...(job.originalItems ? { originalItems: job.originalItems } : {}),
      ...(job.maxParallelImg !== undefined ? { maxParallelImg: job.maxParallelImg } : {}),
      ...(job.maxParallelVid !== undefined ? { maxParallelVid: job.maxParallelVid } : {}),
      ...(job.postedAt !== undefined ? { postedAt: job.postedAt } : {}),
      ...(job.isCrawl ? { isCrawl: job.isCrawl } : {}),
    };
    jobStore.put(record);

    // Write items to jobItems store
    if (job.items) {
      for (let i = 0; i < job.items.length; i++) {
        const item = job.items[i];
        if (!item) continue;
        const itemRecord: JobItemRecord = {
          jobId: job.jobId,
          idx: i,
          subfolder: job.subfolder,
          displayName: item.displayName,
          filename: item.filename,
          status: item.status as JobItemRecord["status"],
          ...(item.error ? { error: item.error } : {}),
          ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
        };
        itemStore.put(itemRecord);
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  await browser.storage.local.remove(LEGACY_JOBS_KEY);
  console.log("[md] Migration complete — legacy downloadJobs key removed.");
}

export let onJobUpdated: ((job: DownloadJob) => void) | null = null;

export function setJobUpdatedListener(listener: (job: DownloadJob) => void): void {
  onJobUpdated = listener;
}

// Convert an IDB job record + item records back into the DownloadJob shape that
// gallery.ts and the options page expect.
function reconstructJob(record: DownloadJobRecord, items: JobItemRecord[]): DownloadJob {
  const sortedItems = items.sort((a, b) => a.idx - b.idx);
  const jobItems: DownloadJobItem[] = sortedItems.map((item) => ({
    displayName: item.displayName,
    filename: item.filename,
    status: item.status,
    ...(item.error ? { error: item.error } : {}),
    ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
  }));
  const job: DownloadJob = {
    jobId: record.jobId,
    hosterId: record.hosterId as DownloadJob["hosterId"],
    subfolder: record.subfolder,
    totalCount: record.totalCount,
    completedCount: record.completedCount,
    failedCount: record.failedCount,
    status: record.status,
    startedAt: record.startedAt,
    items: jobItems,
    ...(record.originalItems
      ? { originalItems: record.originalItems as DownloadJob["originalItems"] }
      : {}),
    ...(record.maxParallelImg ? { maxParallelImg: record.maxParallelImg } : {}),
    ...(record.maxParallelVid ? { maxParallelVid: record.maxParallelVid } : {}),
    ...(record.postedAt ? { postedAt: record.postedAt } : {}),
    ...(record.isCrawl ? { isCrawl: record.isCrawl } : {}),
  };
  return job;
}

// Convert a DownloadJob into an IDB job record (without items).
function toJobRecord(job: DownloadJob): DownloadJobRecord {
  return {
    jobId: job.jobId,
    hosterId: job.hosterId,
    subfolder: job.subfolder,
    totalCount: job.totalCount,
    completedCount: job.completedCount,
    failedCount: job.failedCount,
    status: job.status,
    startedAt: job.startedAt,
    ...(job.originalItems ? { originalItems: job.originalItems } : {}),
    ...(job.maxParallelImg ? { maxParallelImg: job.maxParallelImg } : {}),
    ...(job.maxParallelVid ? { maxParallelVid: job.maxParallelVid } : {}),
    ...(job.postedAt ? { postedAt: job.postedAt } : {}),
    ...(job.isCrawl ? { isCrawl: job.isCrawl } : {}),
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

// Upsert a job + all its items to IDB. Writes ONE job record + N item records
// (not all 101 jobs like the old storage.local approach). The per-item writes
// are simple record puts — no JSON serialization of sibling jobs.
export async function upsertJob(job: DownloadJob): Promise<void> {
  // If the job was cancelled while we were working, respect that.
  if (isJobCancelled(job.jobId) && job.status === "running") {
    job.status = "canceled";
  }

  const record = toJobRecord(job);
  await idbPutJob(record);

  // Write items to jobItems store
  if (job.items) {
    for (let i = 0; i < job.items.length; i++) {
      const item = job.items[i];
      if (!item) continue;
      const itemRecord: JobItemRecord = {
        jobId: job.jobId,
        idx: i,
        subfolder: job.subfolder,
        displayName: item.displayName,
        filename: item.filename,
        status: item.status,
        ...(item.error ? { error: item.error } : {}),
        ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
      };
      await idbPutJobItem(itemRecord);
    }
  }

  // GC: cap completed jobs at 50 (only when a job transitions to done/error)
  if (job.status === "done" || job.status === "error") {
    await idbGcCompletedJobs(50).catch((err) => {
      console.warn("[md] GC pass failed:", err);
    });
  }

  if (onJobUpdated) {
    onJobUpdated(job);
  }
}

// Read a single job with its items reconstructed.
export async function getJob(jobId: string): Promise<DownloadJob | null> {
  const record = await idbGetJob(jobId);
  if (!record) return null;
  const items = await idbGetJobItems(jobId);
  return reconstructJob(record, items);
}

// List all jobs with items reconstructed, sorted by startedAt ascending.
export async function listJobs(): Promise<DownloadJob[]> {
  const records = await idbGetAllJobs();
  const jobs: DownloadJob[] = [];
  for (const record of records) {
    const items = await idbGetJobItems(record.jobId);
    jobs.push(reconstructJob(record, items));
  }
  return jobs.sort((a, b) => a.startedAt - b.startedAt);
}

// Read all job records (without items) — lighter than listJobs, used internally
// where items aren't needed (e.g. cancelAllJobs iterates job metadata only).
async function getAllJobRecords(): Promise<DownloadJobRecord[]> {
  return idbGetAllJobs();
}

// Dedup check: is there a done item with this subfolder + displayName?
// Uses the [subfolder+displayName] composite index — O(1) lookup.
export async function findDoneItem(
  subfolder: string,
  displayName: string,
): Promise<DownloadJobItem | null> {
  const record = await idbFindDoneItem(subfolder, displayName);
  if (!record) return null;
  return {
    displayName: record.displayName,
    filename: record.filename,
    status: "done",
    ...(record.sourceUrl ? { sourceUrl: record.sourceUrl } : {}),
  };
}

export async function deleteJob(jobId: string): Promise<void> {
  cancelJobInCache(jobId);
  await idbDeleteJob(jobId);
  await idbDeleteJobItems(jobId);
}

// Cancel every running job, then wipe the whole job list.
export async function clearAllJobs(): Promise<void> {
  await cancelAllJobs();
  await idbClearAllJobs();
  await idbClearAllJobItems();
}

export async function cancelJob(jobId: string): Promise<void> {
  const record = await idbGetJob(jobId);
  if (!record || record.status !== "running") return;

  record.status = "canceled";
  await idbPutJob(record);

  cancelJobInCache(jobId);
  cancelActiveDownloads(jobId);

  if (onJobUpdated) {
    const items = await idbGetJobItems(jobId);
    onJobUpdated(reconstructJob(record, items));
  }
  void appendLog("warn", "Job cancelled by user", jobId);
}

export async function cancelAllJobs(): Promise<void> {
  const records = await getAllJobRecords();
  for (const record of records) {
    if (record.status === "running") {
      record.status = "canceled";
      await idbPutJob(record);

      cancelJobInCache(record.jobId);
      cancelActiveDownloads(record.jobId);

      if (onJobUpdated) {
        const items = await idbGetJobItems(record.jobId);
        onJobUpdated(reconstructJob(record, items));
      }
      void appendLog("warn", "Job cancelled by user (global stop)", record.jobId);
    }
  }
}

export async function resumeJob(
  jobId: string,
  onStartJob: (req: MDGalleryStartRequest) => void,
): Promise<void> {
  const record = await idbGetJob(jobId);
  if (!record || (record.status !== "canceled" && record.status !== "error")) return;

  uncancelJobInCache(jobId);
  const req: MDGalleryStartRequest = {
    type: "MD_GALLERY_START",
    jobId: record.jobId,
    hosterId: record.hosterId as MDGalleryStartRequest["hosterId"],
    subfolder: record.subfolder,
    items: (record.originalItems ?? []) as MDGalleryStartRequest["items"],
    maxParallelImg: record.maxParallelImg ?? DEFAULT_SETTINGS.maxParallelImg,
    maxParallelVid: record.maxParallelVid ?? DEFAULT_SETTINGS.maxParallelVid,
    ...(record.postedAt ? { postedAt: record.postedAt } : {}),
  };

  record.status = "running";
  record.startedAt = Date.now();
  await idbPutJob(record);

  if (onJobUpdated) {
    const items = await idbGetJobItems(jobId);
    onJobUpdated(reconstructJob(record, items));
  }

  setTimeout(() => {
    onStartJob(req);
  }, 0);
}

export async function resumeAllJobs(
  onStartJob: (req: MDGalleryStartRequest) => void,
): Promise<void> {
  const records = await getAllJobRecords();
  for (const record of records) {
    if (record.status === "canceled" || record.status === "error") {
      void resumeJob(record.jobId, onStartJob).catch(() => {});
    }
  }
}

export async function resumeRunningJobs(): Promise<void> {
  const records = await getAllJobRecords();
  for (const record of records) {
    if (record.status === "running") {
      record.status = "error";
      await idbPutJob(record);

      if (onJobUpdated) {
        const items = await idbGetJobItems(record.jobId);
        onJobUpdated(reconstructJob(record, items));
      }
      void appendLog("warn", "Job marked error: SW restarted mid-run", record.jobId);
    }
  }
}

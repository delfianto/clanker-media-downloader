import browser from "webextension-polyfill";
import type {
  MDFetchBlobRequest,
  MDFetchBlobResponse,
  MDGalleryStartRequest,
  MDListJobsResponse,
  MDDeleteJobRequest,
  MDCancelJobRequest,
  MDResumeJobRequest,
  MDCrawlStartRequest,
  MDCrawlProgressRequest,
  MDCrawlDoneRequest,
  MDGetLogsResponse,
  MDGetJobRequest,
  MDGetJobResponse,
} from "../types/messages";
import { crossOriginFetchBlob } from "./fetcher";
import { initDownloadUi } from "./download-ui";
import { startGalleryJob, attemptDownload } from "./gallery";
import {
  listJobs,
  resumeRunningJobs,
  deleteJob,
  cancelJob,
  resumeJob,
  cancelAllJobs,
  resumeAllJobs,
  clearAllJobs,
} from "./job-store";
import { startCrawlJob, updateCrawlProgress, finishCrawlJob } from "./gallery";
import { sanitizeFilename } from "./sanitize";
import { ALL_MODELS } from "../hosts/index";
import { getLogs, clearLogs } from "./logger";
import { migrateJobsIfNeeded, getJobWithItems } from "./job-store";
import { migrateLogsIfNeeded } from "./logger";

// Reset download UI to recover from unexpected SW termination.
initDownloadUi();

// Recover any jobs that were mid-flight when the SW was last terminated.
void resumeRunningJobs((r) => {
  void startGalleryJob(r);
});

// One-time migration: storage.local → IDB (jobs + logs). Idempotent.
void migrateJobsIfNeeded();
void migrateLogsIfNeeded();

// Sync declarativeNetRequest rules from hoster models.
const DNR_RULE_BASE_ID = 129258;

async function setupDeclarativeRules(): Promise<void> {
  try {
    const existing = await browser.declarativeNetRequest.getDynamicRules();
    const existingIds = new Set(existing.map((r) => r.id));

    // Build the desired rule set from the models.
    const desiredRules = ALL_MODELS.flatMap((model, modelIdx) => {
      const rules = model.headerRules ?? [];
      return rules.map((rule, ruleIdx) => {
        const id = DNR_RULE_BASE_ID + modelIdx * 100 + ruleIdx;
        return {
          id,
          priority: 1,
          action: {
            type: "modifyHeaders" as const,
            requestHeaders: [
              {
                header: rule.header,
                operation: "set" as const,
                value: rule.value,
              },
            ],
          },
          condition: {
            urlFilter: rule.urlFilter,
            resourceTypes: [
              "media" as const,
              "xmlhttprequest" as const,
              "other" as const,
              "image" as const,
            ],
          },
        };
      });
    });

    // Remove rules that exist but are no longer desired, add new ones.
    const desiredIds = new Set(desiredRules.map((r) => r.id));
    const toRemove = [...existingIds].filter((id) => !desiredIds.has(id));
    const toAdd = desiredRules.filter((r) => !existingIds.has(r.id));

    if (toRemove.length > 0 || toAdd.length > 0) {
      await browser.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: toRemove,
        addRules: toAdd,
      });
    }
  } catch (err) {
    console.error("[md] failed to setup declarative net request rules:", err);
  }
}
void setupDeclarativeRules();

type AnyResponse =
  | MDFetchBlobResponse
  | MDListJobsResponse
  | MDGetLogsResponse
  | MDGetJobResponse
  | { error?: string }
  | void;

// Accept the keep-alive port connection from the offscreen document.
// The port itself, along with periodic pings, keeps the SW from idling out.
browser.runtime.onConnect.addListener((port) => {
  if (port.name === "MD_KEEPALIVE_PORT") {
    port.onMessage.addListener(() => {
      // Just receiving the message resets the idle timer.
    });
  }
});

browser.runtime.onMessage.addListener(
  (msg: unknown, _sender: { tab?: { id?: number } }): Promise<AnyResponse> | undefined => {
    const m = msg as Record<string, unknown>;

    if (m["type"] === "MD_FETCH_BLOB" && typeof m["url"] === "string") {
      const req = m as unknown as MDFetchBlobRequest;
      return crossOriginFetchBlob(req.url).catch(
        (err: unknown): MDFetchBlobResponse => ({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    if (
      m["type"] === "MD_DOWNLOAD_SINGLE" &&
      typeof m["url"] === "string" &&
      typeof m["filename"] === "string"
    ) {
      const req = m as { url: string; filename: string; subfolder: string };
      const safeName = sanitizeFilename(req.filename);
      const filePath = req.subfolder ? `${req.subfolder}/${safeName}` : safeName;
      return attemptDownload(req.url, filePath)
        .then((): void => {})
        .catch((err: unknown) => {
          console.error("[md] single download failed:", err);
          return { error: err instanceof Error ? err.message : String(err) };
        });
    }

    if (m["type"] === "MD_GALLERY_START") {
      // Do not return this Promise; returning holds the message port open until completion, causing SW starvation.
      void startGalleryJob(m as unknown as MDGalleryStartRequest).catch((err: unknown) => {
        console.error("[md] gallery job failed:", err);
      });
      return; // Close the message channel immediately
    }

    if (m["type"] === "MD_LIST_JOBS") {
      return listJobs().then((jobs): MDListJobsResponse => ({ jobs }));
    }

    if (m["type"] === "MD_DELETE_JOB" && typeof m["jobId"] === "string") {
      const req = m as unknown as MDDeleteJobRequest;
      return deleteJob(req.jobId).then((): void => {});
    }

    if (m["type"] === "MD_CANCEL_JOB" && typeof m["jobId"] === "string") {
      const req = m as unknown as MDCancelJobRequest;
      return cancelJob(req.jobId).then((): void => {});
    }

    if (m["type"] === "MD_RESUME_JOB" && typeof m["jobId"] === "string") {
      const req = m as unknown as MDResumeJobRequest;
      return resumeJob(req.jobId, (r) => {
        void startGalleryJob(r);
      }).then((): void => {});
    }

    if (m["type"] === "MD_STOP_ALL_JOBS") {
      return cancelAllJobs().then((): void => {});
    }

    if (m["type"] === "MD_RESUME_ALL_JOBS") {
      return resumeAllJobs((r) => {
        void startGalleryJob(r);
      }).then((): void => {});
    }

    if (m["type"] === "MD_CLEAR_JOBS") {
      return clearAllJobs().then((): void => {});
    }

    if (m["type"] === "MD_CRAWL_START" && typeof m["crawlId"] === "string") {
      const req = m as unknown as MDCrawlStartRequest;
      return startCrawlJob({
        crawlId: req.crawlId,
        hosterId: req.hosterId,
        albumName: req.albumName,
        setCount: req.setCount,
      })
        .then((): void => {})
        .catch((err: unknown) => console.error("[md] crawl start failed:", err));
    }

    if (m["type"] === "MD_CRAWL_PROGRESS" && typeof m["crawlId"] === "string") {
      const req = m as unknown as MDCrawlProgressRequest;
      return updateCrawlProgress({
        crawlId: req.crawlId,
        resolvedCount: req.resolvedCount,
        failedCount: req.failedCount,
        setCount: req.setCount,
      })
        .then((): void => {})
        .catch(() => {});
    }

    if (m["type"] === "MD_CRAWL_DONE" && typeof m["crawlId"] === "string") {
      const req = m as unknown as MDCrawlDoneRequest;
      return finishCrawlJob({ crawlId: req.crawlId, aborted: req.aborted })
        .then((): void => {})
        .catch(() => {});
    }

    if (m["type"] === "MD_GET_LOGS") {
      return getLogs().then((logs): MDGetLogsResponse => ({ logs }));
    }

    if (m["type"] === "MD_GET_JOB" && typeof m["jobId"] === "string") {
      const req = m as unknown as MDGetJobRequest;
      return getJobWithItems(req.jobId).then((job): MDGetJobResponse => ({ job }));
    }

    if (m["type"] === "MD_CLEAR_LOGS") {
      return clearLogs().then((): void => {});
    }

    return undefined;
  },
);

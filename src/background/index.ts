import browser from "webextension-polyfill";
import type {
  MDFetchBlobRequest,
  MDFetchBlobResponse,
  MDGalleryStartRequest,
  MDListJobsResponse,
  MDDeleteJobRequest,
  MDCancelJobRequest,
  MDResumeJobRequest,
} from "../types/messages";
import { crossOriginFetchBlob } from "./fetcher";
import { startGalleryJob, attemptDownload } from "./gallery";
import {
  listJobs,
  resumeRunningJobs,
  deleteJob,
  cancelJob,
  resumeJob,
  cancelAllJobs,
  resumeAllJobs,
} from "./job-store";
import { sanitizeFilename } from "./sanitize";

// Recover any jobs that were mid-flight when the SW was last terminated.
void resumeRunningJobs();

// Register header modification rules for Erome downloads (Referer check bypass)
async function setupDeclarativeRules(): Promise<void> {
  const RULE_ID = 129258;
  try {
    const rules = await browser.declarativeNetRequest.getDynamicRules();
    const ruleExists = rules.some((r) => r.id === RULE_ID);
    if (!ruleExists) {
      const newRule = {
        id: RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders" as const,
          requestHeaders: [
            {
              header: "Referer",
              operation: "set" as const,
              value: "https://www.erome.com/",
            },
          ],
        },
        condition: {
          urlFilter: "*://*.erome.com/*",
          resourceTypes: [
            "media" as const,
            "xmlhttprequest" as const,
            "other" as const,
            "image" as const,
          ],
        },
      };
      await browser.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [RULE_ID],
        addRules: [newRule],
      });
    }
  } catch (err) {
    console.error("[md] failed to setup declarative net request rules:", err);
  }
}
void setupDeclarativeRules();

type AnyResponse = MDFetchBlobResponse | MDListJobsResponse | { error?: string } | void;

browser.runtime.onMessage.addListener((msg: unknown): Promise<AnyResponse> | undefined => {
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
    return startGalleryJob(m as unknown as MDGalleryStartRequest).catch((err: unknown) => {
      console.error("[md] gallery job failed:", err);
    });
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

  return undefined;
});

import browser from "webextension-polyfill";
import type {
  MDFetchBlobRequest,
  MDFetchBlobResponse,
  MDGalleryStartRequest,
  MDListJobsResponse,
} from "../types/messages";
import { crossOriginFetchBlob } from "./fetcher";
import { startGalleryJob, listJobs, resumeRunningJobs } from "./gallery";

// Recover any jobs that were mid-flight when the SW was last terminated.
void resumeRunningJobs();

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
    const filePath = req.subfolder ? `${req.subfolder}/${req.filename}` : req.filename;
    return browser.downloads
      .download({
        url: req.url,
        filename: filePath,
        conflictAction: "uniquify",
      })
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

  return undefined;
});

import browser from "webextension-polyfill";
import type { DownloadJob, DownloadJobItem } from "../types/jobs";
import type { MDListJobsResponse, MDGetJobResponse } from "../types/messages";
import { $, el } from "./dom";

// Render job items into a container. Used both for initial card render (when
// items are present from listJobs) and for on-demand load (when a card is
// expanded and items are fetched via MD_GET_JOB).
function renderItemsInto(container: HTMLElement, job: DownloadJob): void {
  container.replaceChildren();
  if (!job.items) return;
  for (const item of job.items) {
    const itemEl = makeItemEl(item);
    container.append(itemEl);
  }
}

function makeItemEl(item: DownloadJobItem): HTMLElement {
  const statusIcon =
    item.status === "done"
      ? "✓"
      : item.status === "error"
        ? "✗"
        : item.status === "running"
          ? "●"
          : "○";
  const itemStatusClass = `item-status ${item.status}`;
  const filenameEl = item.sourceUrl
    ? el("a", {
        className: "item-filename item-filename-link",
        textContent: item.filename,
        title: item.displayName,
        href: item.sourceUrl,
        target: "_blank",
        rel: "noopener noreferrer",
      })
    : el("span", {
        className: "item-filename",
        textContent: item.filename,
        title: item.displayName,
      });
  const itemEl = el("div", { className: "job-item" }, [
    el("span", { className: itemStatusClass, textContent: statusIcon }),
    filenameEl,
  ]);
  if (item.error) {
    itemEl.append(el("span", { className: "item-error", textContent: ` (Error: ${item.error})` }));
  }
  return itemEl;
}

export function formatJobStatus(job: DownloadJob): string {
  if (job.isCrawl) {
    if (job.status === "running") return `Crawling ${job.completedCount} / ${job.totalCount} sets`;
    if (job.status === "done") return `Crawled ${job.totalCount} sets`;
    if (job.status === "canceled")
      return `Stopped — crawled ${job.completedCount} / ${job.totalCount} sets`;
    return `Crawl — ${job.failedCount} sets failed`;
  }
  if (job.status === "running") return `${job.completedCount} / ${job.totalCount}`;
  if (job.status === "done") {
    return job.failedCount > 0
      ? `Done — ${job.failedCount} failed`
      : `Done — ${job.totalCount} files`;
  }
  if (job.status === "canceled") {
    return `Stopped — ${job.completedCount} / ${job.totalCount}`;
  }
  return `Error — ${job.failedCount} failed`;
}

export function renderJobCard(
  job: DownloadJob,
  expandedJobIds: Set<string>,
  onRefresh: () => void,
): HTMLElement {
  const statusClass =
    job.status === "running"
      ? "running"
      : job.status === "done"
        ? "done"
        : job.status === "canceled"
          ? "canceled"
          : "error";
  const pct = job.totalCount > 0 ? job.completedCount / job.totalCount : 0;

  const progress = el("progress", {});
  progress.setAttribute("value", String(job.completedCount));
  progress.setAttribute("max", String(job.totalCount));

  const isExpanded = expandedJobIds.has(job.jobId);
  const itemsContainer = el("div", { className: "job-items" });
  if (job.items && job.items.length > 0) {
    renderItemsInto(itemsContainer, job);
  }

  const deleteBtn = el("button", {
    className: "job-delete-btn",
    title: "Remove from history",
    textContent: "×",
  });
  deleteBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    void browser.runtime
      .sendMessage({
        type: "MD_DELETE_JOB",
        jobId: job.jobId,
      })
      .then(() => {
        onRefresh();
      });
  });

  const headerRight = el("div", { className: "job-header-right" }, [
    el("span", { className: `job-status ${statusClass}`, textContent: formatJobStatus(job) }),
  ]);

  if (job.status === "running") {
    const stopBtn = el("button", {
      className: "job-stop-btn",
      title: "Stop/Cancel download",
      textContent: "Stop",
    });
    stopBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      void browser.runtime
        .sendMessage({
          type: "MD_CANCEL_JOB",
          jobId: job.jobId,
        })
        .then(() => {
          onRefresh();
        });
    });
    headerRight.append(stopBtn);
  } else if (job.status === "canceled" || job.status === "error") {
    const resumeBtn = el("button", {
      className: "job-resume-btn",
      title: "Resume download",
      textContent: "Resume",
    });
    resumeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      void browser.runtime
        .sendMessage({
          type: "MD_RESUME_JOB",
          jobId: job.jobId,
        })
        .then(() => {
          onRefresh();
        });
    });
    headerRight.append(resumeBtn);
  }
  headerRight.append(deleteBtn);

  const card = el(
    "div",
    { className: isExpanded ? "job-card expanded" : "job-card", id: `job-${job.jobId}` },
    [
      el("div", { className: "job-header" }, [
        el("span", {
          className: "job-title",
          textContent: job.isCrawl
            ? `⏳ Crawl — ${job.subfolder || job.hosterId}`
            : job.subfolder || job.hosterId,
        }),
        headerRight,
      ]),
      progress,
      el("div", { className: "job-meta" }, [
        el("span", {
          className: "job-pct",
          textContent: `${Math.round(pct * 100)}%`,
        }),
        el("span", {
          className: "job-hoster",
          textContent: job.hosterId,
        }),
      ]),
      itemsContainer,
    ],
  );

  card.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    if (target.closest(".job-items")) return;

    event.stopPropagation();
    const currentExpanded = card.classList.contains("expanded");
    if (currentExpanded) {
      card.classList.remove("expanded");
      expandedJobIds.delete(job.jobId);
    } else {
      card.classList.add("expanded");
      expandedJobIds.add(job.jobId);
      // Items are NOT loaded by listJobs (metadata only). Fetch them on
      // expand via MD_GET_JOB so the IDB query runs once per click, not
      // once per 3s poll for all 139 jobs.
      if (job.items && job.items.length === 0) {
        try {
          const res = (await browser.runtime.sendMessage({
            type: "MD_GET_JOB",
            jobId: job.jobId,
          })) as MDGetJobResponse;
          if (res.job?.items && res.job.items.length > 0) {
            job.items = res.job.items;
            renderItemsInto(itemsContainer, job);
          }
        } catch {
          // ignore — card stays expanded with empty items
        }
      }
    }
  });

  return card;
}

export async function loadHistoryTab(expandedJobIds: Set<string>): Promise<void> {
  const jobsContainer = $("dl-jobs");
  if (jobsContainer.children.length === 0) {
    jobsContainer.replaceChildren(el("p", { className: "default-note", textContent: "Loading…" }));
  }
  try {
    const res = (await browser.runtime.sendMessage({ type: "MD_LIST_JOBS" })) as MDListJobsResponse;
    jobsContainer.replaceChildren();
    $("history-count").textContent = `${res.jobs.length} jobs`;
    if (res.jobs.length === 0) {
      jobsContainer.append(
        el("p", { className: "default-note", textContent: "No downloads yet." }),
      );
    } else {
      for (const job of res.jobs) {
        jobsContainer.append(
          renderJobCard(job, expandedJobIds, () => void loadHistoryTab(expandedJobIds)),
        );
      }
    }
  } catch {
    jobsContainer.replaceChildren(
      el("p", { className: "default-note", textContent: "Could not load jobs." }),
    );
  }
}

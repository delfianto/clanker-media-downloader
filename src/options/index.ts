import browser from "webextension-polyfill";
import type { HosterId, Settings } from "../types/global";
import type { DownloadJob, DownloadLog } from "../types/jobs";
import type { MDJobProgressMessage } from "../types/messages";
import { ALL_MODELS } from "../hosts/index";
import { DEFAULT_SETTINGS } from "../settings/schema";
import { $, clone, toast, el } from "./dom";
import { renderPanel, renderSidebar } from "./tab-hosters";
import { renderDownloadsSettings } from "./tab-downloads";
import { formatJobStatus, loadHistoryTab } from "./tab-history";
import { formatLogLine, loadLogsTab } from "./tab-logs";

let settings: Settings;
let selected: HosterId = "imagebam";
let saveTimer: ReturnType<typeof setTimeout> | undefined;

// ── persistence ──────────────────────────────────────
function persist(): void {
  void browser.storage.local.set(settings as unknown as Record<string, unknown>).then(
    () => toast("Saved ✓"),
    () => toast("Save failed", true),
  );
}

function persistSoon(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 400);
}

// ── Downloads tab state ───────────────────────────────
let dlRefreshTimer: ReturnType<typeof setInterval> | undefined;
// Pause the 3s polling while live messages are streaming in. Auto-resumes
// after POLL_QUIET_MS of message silence (catches SW-restart edge case).
let pollResumeTimer: ReturnType<typeof setTimeout> | undefined;
const POLL_INTERVAL_MS = 3000;
const POLL_QUIET_MS = 10_000;
type DlSubTab = "settings" | "history" | "logs";
let activeDlSubTab: DlSubTab = "settings";
const expandedJobIds = new Set<string>();

function startPolling(): void {
  clearInterval(dlRefreshTimer);
  dlRefreshTimer = setInterval(() => void loadHistoryTab(expandedJobIds), POLL_INTERVAL_MS);
}

function pausePolling(): void {
  clearInterval(dlRefreshTimer);
  dlRefreshTimer = undefined;
  clearTimeout(pollResumeTimer);
  pollResumeTimer = setTimeout(startPolling, POLL_QUIET_MS);
}

// ── Tabs ──────────────────────────────────────────────
type Tab = "hosters" | "downloads";
let activeTab: Tab = "downloads";

function switchDlSubTab(tab: DlSubTab): void {
  activeDlSubTab = tab;
  clearInterval(dlRefreshTimer);
  clearTimeout(pollResumeTimer);

  for (const t of ["settings", "history", "logs"] as const) {
    $(`stab-${t}`).className = t === tab ? "hoster-item active" : "hoster-item";
    const view = $(`dl-view-${t}`);
    if (t === tab) view.removeAttribute("hidden");
    else view.setAttribute("hidden", "");
  }

  if (tab === "settings") {
    renderDownloadsSettings(settings, persist, persistSoon);
  } else if (tab === "history") {
    void loadHistoryTab(expandedJobIds);
    startPolling();
  } else {
    void loadLogsTab();
    // Refresh logs every 5s from IDB (replaces the old MD_LOG broadcast which
    // flooded 20K IPC messages during a crawl).
    clearInterval(dlRefreshTimer);
    dlRefreshTimer = setInterval(() => void loadLogsTab(), 5000);
  }
}

function switchTab(tab: Tab): void {
  activeTab = tab;

  $("tab-hosters").classList.toggle("active", tab === "hosters");
  $("tab-hosters").setAttribute("aria-selected", String(tab === "hosters"));
  $("tab-downloads").classList.toggle("active", tab === "downloads");
  $("tab-downloads").setAttribute("aria-selected", String(tab === "downloads"));

  if (tab === "hosters") {
    $("view-hosters").removeAttribute("hidden");
    $("view-downloads").setAttribute("hidden", "");
    clearInterval(dlRefreshTimer);
    clearTimeout(pollResumeTimer);
  } else {
    $("view-hosters").setAttribute("hidden", "");
    $("view-downloads").removeAttribute("hidden");
    switchDlSubTab(activeDlSubTab);
  }
}

async function init(): Promise<void> {
  try {
    const keys = { ...DEFAULT_SETTINGS, subfolderPrefix: "" };
    const raw = (await browser.storage.local.get(keys)) as any;
    settings = raw as Settings;
  } catch {
    settings = clone(DEFAULT_SETTINGS);
  }
  // Heal missing hosters (corrupted storage / a hoster added in a new version).
  for (const model of ALL_MODELS) {
    settings.hosters[model.id] ??= clone(DEFAULT_SETTINGS.hosters[model.id]);
  }
  // Heal missing gallery/log settings (upgrade from older storage schema).
  settings.maxParallelImg ??= DEFAULT_SETTINGS.maxParallelImg;
  settings.maxParallelVid ??= DEFAULT_SETTINGS.maxParallelVid;
  settings.maxDownloadRetries ??= DEFAULT_SETTINGS.maxDownloadRetries;
  settings.downloadDirectory ??=
    (settings as any).subfolderPrefix ?? DEFAULT_SETTINGS.downloadDirectory;
  settings.autoFolderPerAlbum ??= DEFAULT_SETTINGS.autoFolderPerAlbum;
  settings.verboseLogging ??= DEFAULT_SETTINGS.verboseLogging;
  settings.skipExistingFiles ??= DEFAULT_SETTINGS.skipExistingFiles;

  $<HTMLSpanElement>("version").textContent = `v${browser.runtime.getManifest().version}`;

  const master = $<HTMLInputElement>("master-enabled");
  master.checked = settings.enabled;
  master.addEventListener("change", () => {
    settings.enabled = master.checked;
    persist();
  });

  $("tab-hosters").addEventListener("click", () => switchTab("hosters"));
  $("tab-downloads").addEventListener("click", () => switchTab("downloads"));
  $("stab-settings").addEventListener("click", () => switchDlSubTab("settings"));
  $("stab-history").addEventListener("click", () => switchDlSubTab("history"));
  $("stab-logs").addEventListener("click", () => switchDlSubTab("logs"));

  $("btn-copy-logs").addEventListener("click", () => {
    void (async () => {
      try {
        const res = (await browser.runtime.sendMessage({ type: "MD_GET_LOGS" })) as {
          logs?: DownloadLog[];
        };
        const logs = res.logs ?? [];
        if (logs.length === 0) {
          toast("No logs to copy", true);
          return;
        }
        const text = logs.map(formatLogLine).join("\n");
        await navigator.clipboard.writeText(text);
        toast(`Copied ${logs.length} entries`);
      } catch {
        toast("Copy failed", true);
      }
    })();
  });

  $("btn-clear-logs").addEventListener("click", () => {
    void browser.runtime.sendMessage({ type: "MD_CLEAR_LOGS" }).then(() => {
      $("log-count").textContent = "0 entries";
      $("dl-logs").replaceChildren(
        el("p", { className: "default-note", textContent: "No logs yet." }),
      );
    });
  });

  $("btn-clear-history").addEventListener("click", () => {
    if (!confirm("Clear all download history?")) return;
    // Route through the SW's clearAllJobs (cancels running jobs, then wipes via
    // runInStorageQueue) instead of writing downloadJobs:[] raw. The raw write
    // raced with in-flight upsertJob calls, which read the stale list and wrote
    // it back — that's how a cleared list "suddenly got populated back".
    void browser.runtime.sendMessage({ type: "MD_CLEAR_JOBS" }).then(() => {
      expandedJobIds.clear();
      void loadHistoryTab(expandedJobIds);
    });
  });

  $("btn-stop-all").addEventListener("click", () => {
    void browser.runtime.sendMessage({ type: "MD_STOP_ALL_JOBS" }).then(() => {
      void loadHistoryTab(expandedJobIds);
    });
  });

  $("btn-resume-all").addEventListener("click", () => {
    void browser.runtime.sendMessage({ type: "MD_RESUME_ALL_JOBS" }).then(() => {
      void loadHistoryTab(expandedJobIds);
    });
  });

  // Live messages from the SW while the Downloads tab is open.
  browser.runtime.onMessage.addListener((msg: unknown) => {
    if (activeTab !== "downloads") return;
    const m = msg as Record<string, unknown>;

    // ── Progress update → History tab card ──
    if (m["type"] === "MD_JOB_PROGRESS" && activeDlSubTab === "history") {
      pausePolling(); // live stream active — defer 3s poll
      const prog = m as Partial<MDJobProgressMessage>;
      const card = document.getElementById(`job-${prog.jobId ?? ""}`);
      if (!card) return;

      const progressEl = card.querySelector("progress");
      if (progressEl) {
        progressEl.setAttribute("value", String(prog.completedCount ?? 0));
        progressEl.setAttribute("max", String(prog.totalCount ?? 0));
      }
      const statusEl = card.querySelector<HTMLElement>(".job-status");
      const st = prog.status ?? "running";
      if (statusEl) {
        statusEl.className = `job-status ${st}`;
        statusEl.textContent = formatJobStatus(prog as unknown as DownloadJob);
      }
      const stopBtn = card.querySelector<HTMLElement>(".job-stop-btn");
      if (stopBtn && st !== "running") {
        stopBtn.remove();

        // Add Resume button on cancel/error
        const headerRight = card.querySelector<HTMLElement>(".job-header-right");
        if (headerRight && !card.querySelector(".job-resume-btn")) {
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
                jobId: prog.jobId,
              })
              .then(() => {
                void loadHistoryTab(expandedJobIds);
              });
          });
          const deleteBtn = headerRight.querySelector(".job-delete-btn");
          if (deleteBtn) {
            headerRight.insertBefore(resumeBtn, deleteBtn);
          } else {
            headerRight.append(resumeBtn);
          }
        }
      }
      const resumeBtn = card.querySelector<HTMLElement>(".job-resume-btn");
      if (resumeBtn && st === "running") {
        resumeBtn.remove();

        // Add Stop button on resume
        const headerRight = card.querySelector<HTMLElement>(".job-header-right");
        if (headerRight && !card.querySelector(".job-stop-btn")) {
          const newStopBtn = el("button", {
            className: "job-stop-btn",
            title: "Stop/Cancel download",
            textContent: "Stop",
          });
          newStopBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            void browser.runtime
              .sendMessage({
                type: "MD_CANCEL_JOB",
                jobId: prog.jobId,
              })
              .then(() => {
                void loadHistoryTab(expandedJobIds);
              });
          });
          const deleteBtn = headerRight.querySelector(".job-delete-btn");
          if (deleteBtn) {
            headerRight.insertBefore(newStopBtn, deleteBtn);
          } else {
            headerRight.append(newStopBtn);
          }
        }
      }
      const pctEl = card.querySelector<HTMLElement>(".job-pct");
      const total = prog.totalCount ?? 0;
      if (pctEl && total > 0) {
        pctEl.textContent = `${Math.round(((prog.completedCount ?? 0) / total) * 100)}%`;
      }

      const itemsContainer = card.querySelector<HTMLElement>(".job-items");

      // Per-item patch — update one row instead of rebuilding all 50.
      // This is the hot path during a crawl: 10,100 single-row patches vs.
      // 10,100 full-container rebuilds.
      if (itemsContainer && prog.itemDelta) {
        const delta = prog.itemDelta;
        const row = itemsContainer.children[delta.idx];
        if (row) {
          const statusEl = row.querySelector<HTMLElement>(".item-status");
          if (statusEl) {
            const icon =
              delta.status === "done"
                ? "✓"
                : delta.status === "error"
                  ? "✗"
                  : delta.status === "running"
                    ? "●"
                    : "○";
            statusEl.className = `item-status ${delta.status}`;
            statusEl.textContent = icon;
          }
          const filenameEl = row.querySelector<HTMLElement>(".item-filename");
          if (filenameEl) {
            filenameEl.textContent = delta.filename;
          }
          const existingError = row.querySelector<HTMLElement>(".item-error");
          if (delta.error) {
            if (existingError) {
              existingError.textContent = ` (Error: ${delta.error})`;
            } else {
              row.append(
                el("span", { className: "item-error", textContent: ` (Error: ${delta.error})` }),
              );
            }
          } else if (existingError) {
            existingError.remove();
          }
        }
      }

      // Full items rebuild — only on job start (initial render).
      if (itemsContainer && prog.items) {
        itemsContainer.replaceChildren();
        for (const item of prog.items) {
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
            itemEl.append(
              el("span", { className: "item-error", textContent: ` (Error: ${item.error})` }),
            );
          }
          itemsContainer.append(itemEl);
        }
      }
    }
  });

  const onUpdateSidebar = (): void =>
    renderSidebar(settings, selected, (id) => {
      selected = id;
      onUpdateSidebar();
      renderPanel(selected, settings, persist, persistSoon, onUpdateSidebar);
    });

  onUpdateSidebar();
  renderPanel(selected, settings, persist, persistSoon, onUpdateSidebar);
  switchTab("downloads");
}

void init();

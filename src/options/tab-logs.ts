import browser from "webextension-polyfill";
import type { DownloadLog } from "../types/jobs";
import type { MDGetLogsResponse } from "../types/messages";
import { $, el } from "./dom";

export function formatTs(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const msStr = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${msStr}`;
}

export function renderLogEntry(entry: DownloadLog): HTMLElement {
  return el("div", { className: "log-entry" }, [
    el("span", { className: "log-ts", textContent: formatTs(entry.ts) }),
    el("span", { className: `log-level log-${entry.level}`, textContent: entry.level }),
    el("span", { className: "log-msg", textContent: entry.msg }),
  ]);
}

// One log record per line: "<ISO timestamp> <level> <msg>". Embedded newlines
// in msg are collapsed so each record stays on a single line for easy sharing.
export function formatLogLine(entry: DownloadLog): string {
  const ts = new Date(entry.ts).toISOString();
  const msg = entry.msg.replace(/[\r\n]+/g, " ");
  return `${ts} ${entry.level} ${msg}`;
}

export async function loadLogsTab(): Promise<void> {
  const container = $("dl-logs");
  if (container.children.length === 0) {
    container.replaceChildren(el("p", { className: "default-note", textContent: "Loading…" }));
  }
  try {
    const res = (await browser.runtime.sendMessage({ type: "MD_GET_LOGS" })) as MDGetLogsResponse;
    const logs = res.logs ?? [];
    $("log-count").textContent = `${logs.length} entries`;
    container.replaceChildren();
    if (logs.length === 0) {
      container.append(el("p", { className: "default-note", textContent: "No logs yet." }));
    } else {
      for (const entry of [...logs].reverse()) {
        container.append(renderLogEntry(entry));
      }
    }
  } catch {
    container.replaceChildren(
      el("p", { className: "default-note", textContent: "Could not load logs." }),
    );
  }
}

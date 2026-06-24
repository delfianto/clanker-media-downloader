import browser from "webextension-polyfill";
import type { DownloadLog, LogLevel } from "../types/jobs";
import type { MDLogMessage } from "../types/messages";
import {
  openDB,
  idbAddLog,
  idbAddLogs,
  idbGetRecentLogs,
  idbCountLogs,
  idbDeleteOldestLogs,
  idbClearAllLogs,
  type LogRecord,
} from "./idb";

const MAX_LOGS = 500;
const FLUSH_INTERVAL_MS = 5000;
const LEGACY_LOGS_KEY = "downloadLogs";

// One-time migration: storage.local downloadLogs → IDB logs store. Idempotent.
export async function migrateLogsIfNeeded(): Promise<void> {
  const db = await openDB();
  const count = await new Promise<number>((resolve, reject) => {
    const req = db.transaction("logs", "readonly").objectStore("logs").count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (count > 0) return; // already migrated

  const raw = await browser.storage.local.get({ [LEGACY_LOGS_KEY]: [] });
  const legacyLogs = (raw[LEGACY_LOGS_KEY] as DownloadLog[] | undefined) ?? [];
  if (legacyLogs.length === 0) return; // fresh install

  console.log(`[md] Migrating ${legacyLogs.length} logs from storage.local to IDB…`);
  const records: LogRecord[] = legacyLogs.map((log) => ({
    ts: log.ts,
    level: log.level,
    msg: log.msg,
    ...(log.jobId ? { jobId: log.jobId } : {}),
  }));
  await idbAddLogs(records);
  await browser.storage.local.remove(LEGACY_LOGS_KEY);
  console.log("[md] Log migration complete — legacy downloadLogs key removed.");
}

// Debug logs are high-volume (one per downloaded file, retry, skip). Buffering
// them in memory and flushing to IDB every 5s avoids 10K individual IDB writes
// during a crawl. Info/warn/error are low-volume and flushed immediately so
// error context is never lost on SW hard-kill.
const debugBuffer: LogRecord[] = [];
let flushTimer: ReturnType<typeof setInterval> | undefined;

function ensureFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushDebugLogs();
  }, FLUSH_INTERVAL_MS);
}

async function flushDebugLogs(): Promise<void> {
  if (debugBuffer.length === 0) return;
  const batch = debugBuffer.splice(0);
  try {
    await idbAddLogs(batch);
    // Cap GC: trim oldest if over limit
    const count = await idbCountLogs();
    if (count > MAX_LOGS) {
      await idbDeleteOldestLogs(count - MAX_LOGS);
    }
  } catch (err) {
    console.warn("[md] Failed to flush debug logs to IDB:", err);
    // Put them back at the front of the buffer for the next flush
    debugBuffer.unshift(...batch);
  }
}

// Flush before reading logs (Copy button) or clearing — ensures buffered
// debug entries are persisted.
export async function flushLogs(): Promise<void> {
  await flushDebugLogs();
}

export async function appendLog(level: LogLevel, msg: string, jobId?: string): Promise<void> {
  if (level === "debug") {
    const cfg = await browser.storage.local.get({ verboseLogging: false });
    if (!cfg["verboseLogging"]) return;
  }

  const entry: LogRecord =
    jobId !== undefined ? { ts: Date.now(), level, msg, jobId } : { ts: Date.now(), level, msg };

  // Broadcast to the Logs tab immediately (if open)
  const broadcast: MDLogMessage = {
    type: "MD_LOG",
    entry: {
      ts: entry.ts,
      level: entry.level,
      msg: entry.msg,
      ...(entry.jobId ? { jobId: entry.jobId } : {}),
    },
  };
  void browser.runtime.sendMessage(broadcast).catch(() => {});

  // Persist: debug → buffer, everything else → IDB immediately
  if (level === "debug") {
    debugBuffer.push(entry);
    ensureFlushTimer();
  } else {
    try {
      await idbAddLog(entry);
      // Cap GC for immediate writes too
      const count = await idbCountLogs();
      if (count > MAX_LOGS) {
        await idbDeleteOldestLogs(count - MAX_LOGS);
      }
    } catch (err) {
      console.warn("[md] Failed to write log to IDB:", err);
    }
  }
}

export async function getLogs(): Promise<DownloadLog[]> {
  await flushLogs(); // ensure buffered debug entries are included
  const records = await idbGetRecentLogs(MAX_LOGS);
  return records.map((r) => ({
    ts: r.ts,
    level: r.level,
    msg: r.msg,
    ...(r.jobId ? { jobId: r.jobId } : {}),
  }));
}

export async function clearLogs(): Promise<void> {
  debugBuffer.length = 0;
  await idbClearAllLogs();
}

// IndexedDB promise wrapper + schema for the clanker-media-dl extension.
//
// Replaces the storage.local blob-based job/log storage with per-record IDB
// stores. The composite [subfolder+displayName] index on jobItems turns the
// dedup scan from O(jobs × items) into O(1) and serves as the skip-if-exists
// cache (since chrome.downloads.search won't work for LO's clear-history
// workflow).
//
// Schema (version 1):
//   jobs     — keyPath: jobId, indexes: startedAt, status, subfolder
//   jobItems — keyPath: autoInc, indexes: jobId, [subfolder+displayName],
//              [jobId+displayName], status
//   logs     — keyPath: autoInc, indexes: ts

const DB_NAME = "clanker-media-dl";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("jobs")) {
        const jobs = db.createObjectStore("jobs", { keyPath: "jobId" });
        jobs.createIndex("startedAt", "startedAt");
        jobs.createIndex("status", "status");
        jobs.createIndex("subfolder", "subfolder");
      }
      if (!db.objectStoreNames.contains("jobItems")) {
        const items = db.createObjectStore("jobItems", {
          keyPath: "autoInc",
          autoIncrement: true,
        });
        items.createIndex("jobId", "jobId");
        items.createIndex("[subfolder+displayName]", ["subfolder", "displayName"]);
        items.createIndex("[jobId+displayName]", ["jobId", "displayName"]);
        items.createIndex("status", "status");
      }
      if (!db.objectStoreNames.contains("logs")) {
        const logs = db.createObjectStore("logs", { keyPath: "autoInc", autoIncrement: true });
        logs.createIndex("ts", "ts");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// ── Transaction helpers ──────────────────────────────────────────────────────

export type TxMode = "readonly" | "readwrite";

export async function tx<T>(
  stores: string[],
  mode: TxMode,
  fn: (stores: Record<string, IDBObjectStore>) => Promise<T>,
): Promise<T> {
  const db = await openDB();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    const storesObj: Record<string, IDBObjectStore> = {};
    for (const name of stores) {
      storesObj[name] = transaction.objectStore(name);
    }
    fn(storesObj)
      .then((result) => {
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error);
      })
      .catch(reject);
  });
}

export function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function cursorToArray<T>(
  cursor: IDBRequest<IDBCursorWithValue | null>,
  limit?: number,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const results: T[] = [];
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (c && (limit === undefined || results.length < limit)) {
        results.push(c.value as T);
      }
      if (c && !c.key) {
        reject(new Error("cursor key is falsy"));
        return;
      }
      if (c && (limit === undefined || results.length < limit)) {
        c.continue();
      } else {
        resolve(results);
      }
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

// ── Job operations ───────────────────────────────────────────────────────────

export async function idbGetJob(jobId: string): Promise<DownloadJobRecord | undefined> {
  const db = await openDB();
  return reqToPromise(db.transaction("jobs", "readonly").objectStore("jobs").get(jobId)) as Promise<
    DownloadJobRecord | undefined
  >;
}

export async function idbGetAllJobs(): Promise<DownloadJobRecord[]> {
  const db = await openDB();
  return reqToPromise(db.transaction("jobs", "readonly").objectStore("jobs").getAll()) as Promise<
    DownloadJobRecord[]
  >;
}

export async function idbPutJob(job: DownloadJobRecord): Promise<void> {
  const db = await openDB();
  await reqToPromise(db.transaction("jobs", "readwrite").objectStore("jobs").put(job));
}

export async function idbDeleteJob(jobId: string): Promise<void> {
  const db = await openDB();
  await reqToPromise(db.transaction("jobs", "readwrite").objectStore("jobs").delete(jobId));
}

export async function idbClearAllJobs(): Promise<void> {
  const db = await openDB();
  await reqToPromise(db.transaction("jobs", "readwrite").objectStore("jobs").clear());
}

// ── JobItem operations ───────────────────────────────────────────────────────

export type JobItemRecord = {
  autoInc?: number;
  jobId: string;
  idx: number;
  subfolder: string;
  displayName: string;
  filename: string;
  status: "pending" | "running" | "done" | "error";
  error?: string;
  sourceUrl?: string;
};

export async function idbPutJobItem(item: JobItemRecord): Promise<void> {
  const db = await openDB();
  await reqToPromise(db.transaction("jobItems", "readwrite").objectStore("jobItems").put(item));
}

export async function idbGetJobItems(jobId: string): Promise<JobItemRecord[]> {
  const db = await openDB();
  const index = db.transaction("jobItems", "readonly").objectStore("jobItems").index("jobId");
  return reqToPromise(index.getAll(jobId)) as Promise<JobItemRecord[]>;
}

export async function idbDeleteJobItems(jobId: string): Promise<void> {
  const db = await openDB();
  const store = db.transaction("jobItems", "readwrite").objectStore("jobItems");
  const index = store.index("jobId");
  await new Promise<void>((resolve, reject) => {
    const req = index.openCursor(jobId);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function idbClearAllJobItems(): Promise<void> {
  const db = await openDB();
  await reqToPromise(db.transaction("jobItems", "readwrite").objectStore("jobItems").clear());
}

// Find a done item by [subfolder+displayName] — used for dedup + skip-if-exists.
export async function idbFindDoneItem(
  subfolder: string,
  displayName: string,
): Promise<JobItemRecord | undefined> {
  const db = await openDB();
  const index = db
    .transaction("jobItems", "readonly")
    .objectStore("jobItems")
    .index("[subfolder+displayName]");
  const result = (await reqToPromise(index.get([subfolder, displayName]))) as
    | JobItemRecord
    | undefined;
  return result && result.status === "done" ? result : undefined;
}

// ── Log operations ───────────────────────────────────────────────────────────

export type LogRecord = {
  autoInc?: number;
  ts: number;
  level: "info" | "warn" | "error" | "debug";
  msg: string;
  jobId?: string;
};

export async function idbAddLog(entry: LogRecord): Promise<void> {
  const db = await openDB();
  await reqToPromise(db.transaction("logs", "readwrite").objectStore("logs").add(entry));
}

export async function idbAddLogs(entries: LogRecord[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await openDB();
  const store = db.transaction("logs", "readwrite").objectStore("logs");
  for (const entry of entries) {
    await reqToPromise(store.add(entry));
  }
}

export async function idbGetRecentLogs(limit: number): Promise<LogRecord[]> {
  const db = await openDB();
  const index = db.transaction("logs", "readonly").objectStore("logs").index("ts");
  return new Promise((resolve, reject) => {
    const results: LogRecord[] = [];
    const req = index.openCursor(null, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && results.length < limit) {
        results.push(cursor.value as LogRecord);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function idbCountLogs(): Promise<number> {
  const db = await openDB();
  return reqToPromise(db.transaction("logs", "readonly").objectStore("logs").count());
}

export async function idbDeleteOldestLogs(count: number): Promise<void> {
  const db = await openDB();
  const store = db.transaction("logs", "readwrite").objectStore("logs");
  const req = store.openCursor();
  await new Promise<void>((resolve, reject) => {
    let deleted = 0;
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && deleted < count) {
        cursor.delete();
        deleted++;
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function idbClearAllLogs(): Promise<void> {
  const db = await openDB();
  await reqToPromise(db.transaction("logs", "readwrite").objectStore("logs").clear());
}

// ── GC: cap completed jobs at N ──────────────────────────────────────────────

export async function idbGcCompletedJobs(maxCompleted: number): Promise<void> {
  const db = await openDB();
  const jobStore = db.transaction(["jobs", "jobItems"], "readwrite").objectStore("jobs");
  const index = jobStore.index("status");
  const doneJobs: DownloadJobRecord[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = index.openCursor("done");
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        doneJobs.push(cursor.value as DownloadJobRecord);
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });
  if (doneJobs.length <= maxCompleted) return;
  // Sort by startedAt ascending — oldest first
  doneJobs.sort((a, b) => a.startedAt - b.startedAt);
  const toRemove = doneJobs.slice(0, doneJobs.length - maxCompleted);
  const itemStore = db.transaction("jobItems", "readwrite").objectStore("jobItems");
  const itemIndex = itemStore.index("jobId");
  for (const job of toRemove) {
    await reqToPromise(jobStore.delete(job.jobId));
    await new Promise<void>((resolve, reject) => {
      const req = itemIndex.openCursor(job.jobId);
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () => reject(req.error);
    });
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export type DownloadJobRecord = {
  jobId: string;
  hosterId: string;
  subfolder: string;
  totalCount: number;
  completedCount: number;
  failedCount: number;
  status: "running" | "done" | "error" | "canceled";
  startedAt: number;
  items?: {
    displayName: string;
    filename: string;
    status: string;
    error?: string;
    sourceUrl?: string;
  }[];
  originalItems?: unknown[];
  maxParallelImg?: number;
  maxParallelVid?: number;
  postedAt?: number;
  isCrawl?: boolean;
};

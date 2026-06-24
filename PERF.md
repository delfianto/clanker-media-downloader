# PERF — Crawl-induced browser lag + storage architecture

> Status: **PLANNED.** Deep investigation completed 2026-06-24 after a 101-gallery
> girlsreleased crawl froze the browser. This document captures the root-cause
> analysis, the seven compounding causes, the impact study for each proposed fix,
> and the IndexedDB storage redesign (logs + jobs) that replaces the current
> `storage.local`-only architecture. No code has been changed yet — this is the
> blueprint.
>
> Scope: `src/background/gallery.ts`, `src/background/job-store.ts`,
> `src/background/logger.ts`, `src/background/download-tracker.ts`,
> `src/options/index.ts`, `src/options/tab-history.ts`, `src/types/jobs.d.ts`,
> `src/types/messages.d.ts`. New module: `src/background/idb.ts` (promise wrapper +
> schema). Migration on first run.

---

## 0. TL;DR

A 101-gallery crawl (~5,050 items, ~10,100 upserts, ~15,150 cancel-check reads,
~10,000 log appends) turns the browser into a slideshow because **every per-item
state change triggers a full-array read/write/broadcast of all jobs to all tabs**.
The complexity is `O(galleries × items × jobs × tabs)` where it should be `O(1)`
per item. The fix stack is:

1. **Targeted tab broadcast** — send progress only to the originating tab + the
   options page, not every open tab. (`gallery.ts:35-51`)
2. **Slim progress messages** — ship counts + the one changed item, not the full
   `job.items` array. Patch one DOM row instead of rebuilding all 50.
3. **In-memory cancel cache** — `Set<jobId>` in the SW; stop reading all 101 jobs
   from storage before every item just to check for cancellation.
4. **Sharded storage → IndexedDB** — one record per job, one record per item, one
   record per log. Composite indexes turn the dedup scan from `O(jobs × items)`
   into `O(1)`.
5. **Log buffering (hybrid)** — buffer debug logs in SW memory, flush
   info/warn/error immediately. Batched IDB writes for the noise tier.
6. **Pause 3s polling during live message stream** — auto-resume after a quiet
   period. Don't remove entirely (SW-restart edge case).
7. **Trim `originalItems` on done jobs only** — done jobs can't be resumed; the
   field is pure waste. Never trim on canceled/error (resume needs it).

Expected reduction for the 101-gallery crawl:

| Metric | Current | Target | Reduction |
|---|---|---|---|
| Object ser/deser (jobs) | ~350M | ~20K record writes | ~17,000× |
| Object ser/deser (logs) | ~10M | ~10K record writes | ~1,000× |
| Dedup comparisons | ~25M | ~5,050 indexed gets | ~5,000× |
| Cancel-check reads | ~150M objects | 0 (cache) / ~150K (no cache) | ∞ / ~1,000× |
| Tab IPC round-trips | ~303,000 | ~20,200 (options page only) | ~15× |
| History-tab DOM rebuilds | ~505,000 node create/destroy | ~10,100 single-row patches | ~50× |

---

## 1. Investigation — the seven compounding causes

Ranked by severity. Each is real and measured against the code as of `8bbd9b2`.
The 101-gallery scenario is the worst case that triggered the report; smaller
crawls hit the same architecture, just with smaller constants.

### 1.1 `broadcastProgressToTabs` spams every tab on every item change

**Location:** `gallery.ts:35-51`

```ts
async function broadcastProgressToTabs(job: DownloadJob): Promise<void> {
  const tabs = await browser.tabs.query({});              // ← enumerate ALL tabs
  for (const tab of tabs) {
    if (tab.id) {
      await browser.tabs.sendMessage(tab.id, msg).catch(() => {});  // ← serial await
    }
  }
}
```

`broadcastProgress` (`gallery.ts:21-33`) fires on every `upsertJob` call
(via `setJobUpdatedListener(broadcastProgress)` at `gallery.ts:54`). In `runQueue`,
`upsertJob` is called **2× per item** — once when `status → "running"`
(`gallery.ts:188`) and once when the item completes or fails
(`gallery.ts:298`).

**Math for 101 galleries × ~50 images each:**

- 101 × 50 × 2 = **10,100 `broadcastProgress` calls**
- Each calls `browser.tabs.query({})` → 10,100 heavy async API calls
- With 30 tabs open: 10,100 × 30 = **303,000 `tabs.sendMessage` IPC round-trips**
- The `await` in the `for` loop makes it serial — one slow tab blocks the next
  broadcast, which blocks the next `upsertJob`, which blocks the queue
- Content scripts on imx.to, imagevenue, girlsreleased, reddit, gmail, … ALL
  receive these messages. They don't use them, but the IPC cost is paid
  regardless. Every content script's `onMessage` listener fires 10,100 times.

**Why it's the worst offender:** it's the only cause that crosses the
extension-process boundary into every other tab's content script context. The
other causes are intra-SW or intra-options-page. This one poisons the whole
browser.

### 1.2 `MD_JOB_PROGRESS` ships the full `job.items` array on every broadcast

**Location:** `gallery.ts:21-33`

```ts
const msg: MDJobProgressMessage = {
  type: "MD_JOB_PROGRESS",
  jobId: job.jobId,
  completedCount: job.completedCount,
  totalCount: job.totalCount,
  failedCount: job.failedCount,
  status: job.status,
  ...(job.items ? { items: job.items } : {}),   // ← 50-item array, every message
};
```

For a 50-image gallery, every progress message serializes all 50
`DownloadJobItem` objects via structured clone and ships them to the options
page. The options page handler (`index.ts:260-296`) then does
`itemsContainer.replaceChildren()` and rebuilds all 50 DOM nodes on **every
single message**:

```ts
itemsContainer.replaceChildren();           // ← destroy all 50 nodes
for (const item of prog.items) {            // ← rebuild all 50 nodes
  // ... el("div", ...), el("span", ...), el("a", ...)
  itemsContainer.append(itemEl);
}
```

**Math:**
- 10,100 broadcasts × 50 items = **505,000 item serializations** via
  structured clone
- 505,000 DOM node create/destroy cycles in the options page alone
- Layout thrashing: each `replaceChildren` + `append` loop triggers reflow
  unless the browser batches (it doesn't — the message loop is synchronous
  from the listener's perspective)

**Compounding with 1.1:** the slim message that `broadcastProgressToTabs`
sends (`gallery.ts:36-42`) doesn't include `items`, so the tab spam is
"only" counts. But the `browser.runtime.sendMessage` path (`gallery.ts:31`)
**does** include items, and that's the one the options page receives. So the
options page eats the full 505,000-node rebuild cost.

### 1.3 `readJobs()` reads ALL 101 jobs (with `originalItems`) on every queue iteration

**Location:** `gallery.ts:169` (and `gallery.ts:213`, `gallery.ts:237`)

```ts
async function runOne(): Promise<void> {
  while (cursor < entries.length) {
    const currentJobs = await readJobs();                          // ← 10,000 objects
    const currentJob = currentJobs.find((j) => j.jobId === job.jobId);
    if (!currentJob || currentJob.status === "canceled") break;
    // ...
  }
}
```

`readJobs()` (`job-store.ts:18-21`) reads the entire `downloadJobs` key from
`storage.local`, which deserializes ALL jobs with ALL their data:

```ts
export async function readJobs(): Promise<DownloadJob[]> {
  const stored = await browser.storage.local.get({ [JOBS_KEY]: [] });
  return (stored[JOBS_KEY] as DownloadJob[] | undefined) ?? [];
}
```

**Per-item read count:** 3× per item
1. `gallery.ts:169` — before setting status to "running"
2. `gallery.ts:213` — after resolve, before download
3. `gallery.ts:237` — inside the retry loop, on every attempt

**Math:** 101 galleries × 50 items × 3 reads = **15,150 full storage reads**.
Each deserializes 101 jobs × (`items` + `originalItems`) = ~10,000 objects per
read. Total: **~150 million object deserializations from storage**.

`originalItems` (`jobs.d.ts:36`) is retained per-job for resume support and
**never trimmed** — even after all items complete. 101 jobs × 50 items = 5,050
`GalleryJobItem` objects permanently in storage, read on every `readJobs()`
call. They're only needed by `resumeJob` (`job-store.ts:141`), which only runs
on canceled/error jobs — but they're paid for on every read of every job.

### 1.4 `upsertJob` writes ALL 101 jobs back to storage on every call

**Location:** `job-store.ts:29-56`

```ts
export async function upsertJob(job: DownloadJob): Promise<void> {
  return runInStorageQueue(async () => {
    const jobs = await readJobs();                                // ← full read
    const idx = jobs.findIndex((j) => j.jobId === job.jobId);
    // ... mutate jobs[idx] ...
    await browser.storage.local.set({ [JOBS_KEY]: jobs });        // ← full write
  });
}
```

Every upsert reads everything, mutates one job, writes everything back.

**Math:** 10,100 upserts × (full read + full write of 101 jobs) = **20,200 full
storage round-trips**, each serializing/deserializing ~10,000 objects. All
queued through `runInStorageQueue` (`job-store.ts:12-16`), so they serialize —
5 parallel workers per gallery all bottleneck through one queue:

```ts
let storagePromise: Promise<any> = Promise.resolve();
export async function runInStorageQueue<T>(fn: () => Promise<T>): Promise<T> {
  const myTurn = storagePromise.then(fn);
  storagePromise = myTurn.catch(() => {});
  return myTurn;
}
```

The promise chain grows to 20,200+ links during a crawl, each retaining closure
scope. This is also a memory leak — see 1.7.

### 1.5 `appendLog` reads + writes ALL 500 logs on every entry

**Location:** `logger.ts:17-20`

```ts
const raw = await browser.storage.local.get({ [LOGS_KEY]: [] });
const logs: DownloadLog[] = [...((raw[LOGS_KEY] as DownloadLog[] | undefined) ?? []), entry];
if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
await browser.storage.local.set({ [LOGS_KEY]: logs });
```

Each `appendLog` reads all 500 entries, spreads into a new array, appends one,
writes all 500 back.

With `verboseLogging: true` (the default, `schema.ts:22`), the SW emits debug
logs for every downloaded file, every retry, every skip:
- `gallery.ts:182` — "Skipped (already downloaded)"
- `gallery.ts:248` — "Retry N/M for …"
- `gallery.ts:279` — "Downloaded: …"
- `item-resolver.ts:61` — "Fetching viewer: …"
- `item-resolver.ts:97` — "Resolving URL: …"
- Plus `onRetry` callbacks in `fetchWithRetry` and `resolveItem`

~5,050 "Downloaded:" logs + retry/skip/resolve logs = **easily 10,000+ log
writes**, each reading and writing 500 entries = **5M object operations**.

And each `appendLog` also calls `browser.runtime.sendMessage({ type: "MD_LOG",
entry })` (`logger.ts:23`) — another 10,000 IPC messages to the options page,
where the Logs tab handler (`index.ts:300-310`) prepends a DOM node for each.

### 1.6 The 3-second polling interval fights the live message handler

**Location:** `index.ts:55`

```ts
dlRefreshTimer = setInterval(() => void loadHistoryTab(expandedJobIds), 3000);
```

`loadHistoryTab` (`tab-history.ts:179-204`) does `MD_LIST_JOBS` (reads all 101
jobs from storage via the SW), then `jobsContainer.replaceChildren()` and
rebuilds **every job card with every item**:

```ts
for (const job of res.jobs) {
  jobsContainer.append(renderJobCard(job, expandedJobIds, () => void loadHistoryTab(...)));
}
```

With 101 jobs × 50 items: **5,050 DOM nodes destroyed and recreated every 3
seconds**, while the live message handler is simultaneously trying to patch
individual cards via `index.ts:176-297`.

They fight — the interval wipes the message handler's incremental patches
(because `replaceChildren()` throws away the patched nodes), the message
handler re-patches cards the interval just built. Both consume main-thread
time. The polling never pauses, even when the message stream is active. It's
redundant during an active crawl — the live messages already keep the UI
current. The interval only earns its keep for the SW-restart edge case (see
Fix 6 analysis).

### 1.7 `activeJobPromise` chaining + `storagePromise` growth — SW memory retention

**Location:** `gallery.ts:386-432`, `job-store.ts:10-16`

```ts
let activeJobPromise: Promise<void> = Promise.resolve();
// ...
const myTurn = activeJobPromise.then(async () => { /* ... */ });
activeJobPromise = myTurn;
await myTurn;
```

Jobs are chained via `activeJobPromise`. This keeps the SW alive for the entire
101-gallery crawl (MV3 SWs are normally killed after 30s idle). Over hours of
runtime, retained memory accumulates:

- The `entries` arrays (`gallery.ts:366` — 50 objects per gallery) are retained
  in closure scope for each queued job's `runQueue` call
- The `job` object with `originalItems` is retained for the duration of each
  job
- `pendingDownloads` map (`download-tracker.ts:9`) accumulates entries —
  cleaned on completion, but during heavy parallelism it can hold many entries
- `storagePromise` chain (`job-store.ts:10`) is a promise chain that grows with
  every queued operation — 20,200+ links long during a crawl, each retaining
  closure scope of `runInStorageQueue`'s `fn` argument. The chain is never
  truncated; each link holds a reference to its `fn` until the chain is GC'd,
  which doesn't happen until the entire chain resolves. For a multi-hour crawl,
  this is a slow leak.

---

## 2. Fix impact analysis

Each fix evaluated for functional regressions, risk, and effort. Ordered by
safety (safest first).

### Fix 1 — Targeted tab broadcast (addresses 1.1)

**Change:** `broadcastProgressToTabs` sends only to the crawl's originating
tab + the options page, not `tabs.query({})`.

**Breaks:** Crawl-phase cancellation. `gallery-runner.ts:146-157` listens for
`MD_JOB_PROGRESS` with `status: "canceled"` via `window.postMessage` — the
ISOLATED world relays it from `tabs.sendMessage`. If we stop broadcasting to
content tabs, hitting Stop on a crawl won't abort the in-flight API fetches;
the crawl runs to completion then dumps all download jobs.

**Doesn't break:** Download-queue cancellation. That's handled by `readJobs()`
polling inside `runQueue` (`gallery.ts:169,213,237`), not by broadcast
messages. Even with Fix 3's in-memory cache, the cancel path still works.

**Fix for the regression:** Store the crawl's `tabId` when `MD_CRAWL_START`
arrives (passed from the content script via the ISOLATED relay), send only to
that one tab. The options page gets the `browser.runtime.sendMessage` path
(which is already separate, `gallery.ts:31`). For non-crawl jobs, content tabs
don't need progress messages at all — only the options page does.

**Verdict:** Safe with targeted delivery. Zero user-visible change.

### Fix 2 — Slim progress messages (addresses 1.2)

**Change:** Drop `job.items` from `MD_JOB_PROGRESS`. Send counts + the one
changed item (index + status + filename + error). The options page patches a
single row instead of rebuilding all 50.

**Breaks:** Nothing, but requires rewriting the live message handler
(`index.ts:260-296`). Currently it does `itemsContainer.replaceChildren()` +
rebuilds all 50 rows on every message. With per-item patches, it needs to find
row `[idx]` and update its status icon + filename in place.

**Edge case — options page opened mid-job:** Currently the first progress
message after opening populates the full item list. With slim messages, the UI
would show counts but no item rows until the next 3s polling fires (which does
`MD_LIST_JOBS` and gets the full snapshot). **~3 second delay** before item
rows appear. Fixable by having `loadHistoryTab` run immediately on tab switch
(it already does — `index.ts:54`), so the initial render comes from
`MD_LIST_JOBS`, not from a progress message. No real regression.

**Crawl jobs:** Already have no `items` array (`isCrawl: true`). Already
handled by the `prog.items` check. No impact.

**New message field:** `MDJobProgressMessage` gains `itemDelta?: { idx: number;
status: string; filename: string; error?: string; sourceUrl?: string }`. The
options page handler checks for `itemDelta` and patches one row; falls back to
full rebuild only if `items` is present (backward compat during migration).

**Verdict:** No functional loss. Handler rewrite needed but mechanical.

### Fix 3 — In-memory cancel cache (addresses 1.3's cancel-check reads)

**Change:** Keep a `Set<jobId>` in the SW. `cancelJob` / `cancelAllJobs` /
`clearAllJobs` add to it. `runQueue` checks the set instead of `readJobs()`.

**Breaks:** Nothing if done right. The cache is the source of truth for
"should I stop?" during a crawl. Storage is still the source of truth for
"what's the job state?" for the options page and for resume.

**SW restart edge case:** The set is lost on restart. But `resumeRunningJobs()`
(`job-store.ts:174`) already marks all "running" jobs as "error" on restart —
they won't resume anyway. The cache being empty after restart is consistent
with "no jobs are running after restart."

**Race condition:** None. All cancel paths go through the SW's `onMessage`
handler — single context, single thread. The set and storage stay in sync
because `cancelJob` writes both (storage via the existing `upsertJob`, cache
via `cancelledJobs.add(jobId)`).

**Verdict:** Zero functional impact. Pure win. The safest fix.

### Fix 4 — IndexedDB for jobs (addresses 1.3, 1.4, dedup, skip-cache)

**Change:** Replace `storage.local` `downloadJobs` key with two IDB stores.
See §3 for the full schema.

**Breaks:** Nothing user-visible, but **significant code churn** in
`job-store.ts`. Every function (`readJobs`, `upsertJob`, `listJobs`,
`deleteJob`, `cancelJob`, `clearAllJobs`, `resumeJob`, `resumeAllJobs`,
`resumeRunningJobs`) needs rewriting against IDB.

**Migration:** Existing users have all jobs under one `downloadJobs` key. Need
a one-time migration on SW startup: read old key, write each job + each item
into IDB, delete old key. If the migration crashes mid-way, the old key is
still there — re-run on next startup. Idempotent (check if IDB already has
data before migrating).

**Dedup win:** The current dedup at `gallery.ts:330-340` is a nested loop:
for each new item, scan all history jobs with matching subfolder, then scan
their items. With IDB's `[subfolder+displayName]` composite index on
`jobItems`, it's a single `index.get(key)`. See §3.2.

**Skip-if-exists:** Since LO clears chrome download history, `chrome.downloads.search`
won't work. The IDB `jobItems` store with `[subfolder+displayName]` index
serves as our own persistent skip-cache. See §3.3.

**Verdict:** No user-visible change, but the heaviest refactor. Highest effort,
highest payoff. Fixes 1+3 already eliminate most of the `readJobs` overhead,
but the dedup win and skip-cache are IDB-exclusive.

### Fix 5 — Hybrid log buffering (addresses 1.5)

**Change:** Buffer debug logs in SW memory, flush to IDB every 5s or on
`runtime.onSuspend`. Flush info/warn/error immediately.

**Breaks:** Debug-log loss on SW hard-kill (acceptable — they're noise). No
error-log loss (immediate flush). Logs tab updates in bursts every ~5s for
debug logs, immediate for errors — minor UX change, feels less "live" for the
noise tier.

**Copy logs button** (`index.ts:116-132`): reads from IDB. If debug logs are
buffered but not flushed, Copy misses recent debug entries. Fix: flush-before-
copy (send a `MD_FLUSH_LOGS` message to the SW before reading) or read from
the buffer (SW responds with buffer + IDB contents).

**Hybrid approach:** Buffer only debug logs (90% of the volume). Flush
info/warn/error immediately. Best of both — no error log loss, debug-log
volume solved.

**Verdict:** Safe with the hybrid approach. Full buffering risks error-log
loss.

### Fix 6 — Pause 3s polling during live messages (addresses 1.6)

**Change:** When a `MD_JOB_PROGRESS` message arrives, pause the 3s interval.
Auto-resume after N seconds of message silence (e.g., 10s).

**Breaks:** Nothing if implemented as "pause + auto-resume after quiet period."
The quiet-period timeout acts as the fallback.

**Without the fallback (full removal):** Three edge cases regress:
1. **SW dies mid-job** — live messages stop, UI freezes on last state. Polling
   catches this. Without it, the user sees a stale "running" job forever.
2. **Options tab backgrounded then refocused** — `setInterval` is throttled to
   ~1/min when backgrounded; the live handler may also miss messages. On
   refocus, polling resyncs. Without it, stale UI on refocus.
3. **Options page opened after job already started** — `loadHistoryTab` runs on
   tab switch (`index.ts:54`), so the initial load is fine. But if a job
   starts while the options page is already open and on a different sub-tab
   (e.g., Settings), switching to History would call `loadHistoryTab` once —
   then no polling means no updates until a live message happens to arrive.

**Verdict:** Safe with "pause + auto-resume after N seconds quiet." Don't
remove entirely.

### Fix 7 — Trim `originalItems` on done jobs only (addresses 1.3, 1.7)

**Change:** When a job transitions to "done" (`gallery.ts:418`), delete
`job.originalItems` before the final `upsertJob`.

**Breaks:** Nothing for **done** jobs — done jobs can't be resumed (`resumeJob`
only accepts "canceled" or "error", `job-store.ts:135`). Their `originalItems`
is pure waste.

**DON'T trim error/canceled jobs** — those CAN be resumed, and `resumeJob` uses
`job.originalItems || []` (`job-store.ts:141`). Trimming those would make
resume do nothing. **Real regression.**

**Dedup unaffected:** The dedup check (`gallery.ts:330-340`) uses `hj.items`
(the `DownloadJobItem[]` array), not `hj.originalItems`. The items array
stays. Only the internal pre-resolution `GalleryJobItem[]` is trimmed.

**Verdict:** Safe for done jobs only. Zero functional impact. Trimming
error/canceled would break resume.

---

## 3. IndexedDB architecture (Fix 4 + logs)

Two databases (or one database with multiple stores — one DB is simpler for
transaction boundaries). One database: `clanker-media-dl`, version 1.

### 3.1 Schema

```
Database: clanker-media-dl  (version 1)

Store: jobs
  keyPath:     "jobId"
  indexes:
    "startedAt"     — sort for History tab listing
    "status"       — GC: find completed jobs to cap at 50
    "subfolder"    — dedup candidate lookup

Store: jobItems
  keyPath:     "autoInc"     (auto-increment)
  indexes:
    "jobId"                    — cascade delete on job removal
    "[subfolder+displayName]"  — dedup + skip-if-exists (composite)
    "[jobId+displayName]"      — per-job item lookup
    "status"                   — find done items for skip-cache

Store: logs
  keyPath:     "autoInc"     (auto-increment)
  indexes:
    "ts"          — sort descending for Logs tab
```

**Why two job stores (denormalized)?** Flattening `job.items` into a separate
`jobItems` store is what enables:
- Per-item upserts (write one record, not the whole job)
- Composite `[subfolder+displayName]` index (dedup + skip-cache in O(1))
- Cascade delete via `jobId` index (GC removes a job's items efficiently)
- History tab lists jobs without loading items (lighter list, pay-per-click
  for item detail)

**`subfolder` on `jobItems`:** denormalized from the parent job, written once
when the job starts, never updated. This is what makes the `[subfolder+displayName]`
composite index work without a join.

### 3.2 Write path — per-item upsert

**Current (`storage.local`):**
```
upsertJob(job):
  readJobs()                          → parse 101 jobs × ~100 objects = ~10,000
  mutate jobs[idx]
  storage.set({ downloadJobs: jobs }) → serialize 10,000 back
```

**With IDB:**
```
upsertJobItem(jobId, idx, itemPatch):
  tx = db.transaction(["jobs", "jobItems"], "readwrite")
  tx.objectStore("jobItems").put({ ...item, jobId, idx, ...itemPatch })
  // update job counters — read-modify-write of ONE job record
  job = tx.objectStore("jobs").get(jobId)
  job.completedCount++; job.failedCount++; ...
  tx.objectStore("jobs").put(job)
  tx.commit()
```

One transaction, two record writes. No sibling parse. The other 100 jobs are
never touched.

**Math for 10,100 upserts:**
- Current: ~200M object ser/deser
- IDB: ~20,200 record writes
- **~17,000× reduction**

### 3.3 Read paths

#### Cancel check (15,150 reads during a crawl)

With Fix 3's in-memory cache: `cancelledJobs.has(jobId)` — **zero IDB reads**.
Without the cache: `db.transaction("jobs").objectStore("jobs").get(jobId)` —
one record, ~10 fields, no items. **150K objects vs. 150M** = ~1,000× reduction.

#### Dedup at job start (`gallery.ts:330-340`)

**Current:** for each item in the new job, iterate all history jobs with
matching subfolder, then iterate their items looking for `displayName` match +
`status === "done"`. 50 items × (101 jobs × 50 items) = **252,500 comparisons**
per new job. During a 101-gallery crawl: **25M comparisons**.

**With IDB:**
```
tx = db.transaction("jobItems", "readonly")
idx = tx.objectStore("jobItems").index("[subfolder+displayName]")
for (const item of newItems) {
  const existing = await idx.get([item.subfolder, item.displayName])
  if (existing && existing.status === "done") {
    // already downloaded — mark as done
  }
}
```

50 items × 1 indexed get = **50 gets** per new job. 101 jobs = **5,050 gets**.
**~5,000× reduction.** The composite index is the killer feature that
`storage.local` sharding can't replicate.

#### History tab list (every 3s)

**Current:** `readJobs()` — parse all 101 jobs with all items = ~10,000
objects.

**With IDB:**
```
tx = db.transaction("jobs", "readonly")
idx = tx.objectStore("jobs").index("startedAt")
const jobs = await idx.getAll()   // job metadata only, no items
```

101 records × ~10 fields = ~1,000 objects. **10× lighter.** Expand a card →
`jobItems.index("jobId").getAll(jobId)` — 50 records, only when the user
clicks. **Pay-per-click instead of always-loaded.**

#### Skip-if-exists (new feature, replaces `chrome.downloads.search`)

Since LO clears chrome download history, `chrome.downloads.search` won't work.
The IDB `jobItems` store with `[subfolder+displayName]` index serves as our
own persistent skip-cache:

```
async function isAlreadyDownloaded(subfolder, displayName): Promise<boolean> {
  const tx = db.transaction("jobItems", "readonly")
  const idx = tx.objectStore("jobItems").index("[subfolder+displayName]")
  const existing = await idx.get([subfolder, displayName])
  return existing && existing.status === "done"
}
```

Before each download attempt in `runQueue`, call `isAlreadyDownloaded`. If
true, mark the item as done and skip. O(1) indexed lookup. Persists across SW
restarts, browser restarts, and chrome-downloads-history clearing.

**Retention caveat:** the 50-completed-jobs cap means older completed jobs'
items get cascade-deleted. For a 101-gallery crawl, the first 51 jobs' items
would be evicted by the time the crawl finishes. If longer skip-cache
retention is needed, add a separate `downloadedFiles` store (keyPath
`[subfolder+filename]`) that persists independently of the job cap. On each
successful download, write to both `jobItems` and `downloadedFiles`. Skip-check
reads `downloadedFiles`. This decouples skip-cache retention from job history
retention. ~1 extra record write per download. **Deferred — start with the
unified store, add `downloadedFiles` only if the 50-job cap proves too
short.**

### 3.4 Log store (Fix 5 + IDB)

**Append (debug, buffered):**
```
// SW keeps an in-memory array: debugLogBuffer: DownloadLog[]
function appendDebugLog(entry) {
  debugLogBuffer.push(entry)
  // flush scheduled every 5s via setInterval, or on onSuspend
}

async function flushDebugLogs() {
  if (debugLogBuffer.length === 0) return
  const batch = debugLogBuffer.splice(0)
  const tx = db.transaction("logs", "readwrite")
  for (const entry of batch) tx.objectStore("logs").add(entry)
  await tx.done
  // cap GC:
  const count = await tx.objectStore("logs").count()
  if (count > 500) {
    const cursor = tx.objectStore("logs").openCursor()  // ascending by autoInc
    for (let i = 0; i < count - 500; i++) {
      await cursor.delete(); await cursor.continue()
    }
  }
}
```

**Append (info/warn/error, immediate):**
```
async function appendImportantLog(entry) {
  const tx = db.transaction("logs", "readwrite")
  tx.objectStore("logs").add(entry)
  await tx.done
}
```

**Read latest 500 (Logs tab):**
```
const tx = db.transaction("logs", "readonly")
const idx = tx.objectStore("logs").index("ts")
const cursor = idx.openCursor(null, "prev")   // descending by ts
const logs = []
for (let i = 0; i < 500 && cursor; i++) {
  logs.push(cursor.value); await cursor.continue()
}
```

Native cursor, no JSON parse of a giant blob. **1,000× reduction** in log
object operations.

### 3.5 50-job cap + cascade delete

**Current:** `jobs.filter(running).concat(jobs.filter(!running).slice(0, 50))`
— one array operation during `upsertJob`.

**With IDB:** when a job transitions to "done", run a GC pass:
```
async function gcCompletedJobs() {
  const tx = db.transaction(["jobs", "jobItems"], "readwrite")
  const idx = tx.objectStore("jobs").index("status")
  const cursor = idx.openCursor(IDBKeyRange.only("done"))
  let count = 0
  while (cursor) {
    count++
    if (count > 50) {
      // cascade delete items
      const itemCursor = tx.objectStore("jobItems")
        .index("jobId").openCursor(IDBKeyRange.only(cursor.value.jobId))
      while (itemCursor) {
        itemCursor.delete(); await itemCursor.continue()
      }
      cursor.delete()
    }
    await cursor.continue()
  }
}
```

~5 extra record deletes per job completion. Negligible vs. the 10,000 upserts
it's gating. Runs in the same transaction as the job's "done" transition.

### 3.6 Migration — `storage.local` → IDB

On SW startup, check if IDB has been initialized:
```
async function migrateIfNeeded() {
  const db = await openDB()
  const count = await db.count("jobs")
  if (count > 0) return  // already migrated

  const raw = await browser.storage.local.get({ downloadJobs: [], downloadLogs: [] })
  const jobs = raw.downloadJobs as DownloadJob[] ?? []
  const logs = raw.downloadLogs as DownloadLog[] ?? []

  if (jobs.length === 0 && logs.length === 0) return  // fresh install

  const tx = db.transaction(["jobs", "jobItems", "logs"], "readwrite")
  for (const job of jobs) {
    tx.objectStore("jobs").put(stripOriginalItemsIfDone(job))
    if (job.items) {
      for (const [idx, item] of job.items.entries()) {
        tx.objectStore("jobItems").put({ ...item, jobId: job.jobId, idx, subfolder: job.subfolder })
      }
    }
  }
  for (const log of logs) {
    tx.objectStore("logs").add(log)
  }
  await tx.done

  // Clean up old keys
  await browser.storage.local.remove(["downloadJobs", "downloadLogs"])
}
```

Idempotent — if it crashes mid-migration, the old keys are still there and IDB
has partial data, but the `count > 0` check means it won't re-run. The
`count > 0` guard is the "already migrated" signal. For a crashed partial
migration, a manual `chrome.storage.local.remove("downloadJobs")` from the
options page's dev console is the recovery path. (We could add a "Repair
storage" button later if this becomes a real concern.)

### 3.7 Promise wrapper for IDB

IDB's callback API needs a promise wrapper (~40 lines) or a tiny library
(`idb-keyval` is 600 bytes, `idb` is 1.5KB). The project doesn't use external
deps, so the wrapper is the move. New module: `src/background/idb.ts`:

```ts
// Sketch — not committed yet
let dbPromise: Promise<IDBDatabase> | null = null

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open("clanker-media-dl", 1)
    req.onupgradeneeded = () => {
      const db = req.result
      // jobs store
      const jobs = db.createObjectStore("jobs", { keyPath: "jobId" })
      jobs.createIndex("startedAt", "startedAt")
      jobs.createIndex("status", "status")
      jobs.createIndex("subfolder", "subfolder")
      // jobItems store
      const items = db.createObjectStore("jobItems", { keyPath: "autoInc", autoIncrement: true })
      items.createIndex("jobId", "jobId")
      items.createIndex("[subfolder+displayName]", ["subfolder", "displayName"])
      items.createIndex("[jobId+displayName]", ["jobId", "displayName"])
      items.createIndex("status", "status")
      // logs store
      const logs = db.createObjectStore("logs", { keyPath: "autoInc", autoIncrement: true })
      logs.createIndex("ts", "ts")
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

// Transaction helpers: tx<T>(stores, mode, fn) → Promise<T>
//getAll, get, put, delete, openCursor wrappers
```

~80 lines total. No external deps.

---

## 4. Implementation order

Ordered by safety (safest first) and dependency (Fix 3 before Fix 4, because
the cancel cache reduces IDB read load during the transition).

### Phase 1 — zero-risk SW optimizations (no storage change)

| Fix | Files | Effort | Risk |
|---|---|---|---|
| 3 — cancel cache | `gallery.ts`, `job-store.ts` | Low | None |
| 7 — trim `originalItems` on done | `gallery.ts` | Low | None |
| 1 — targeted tab broadcast | `gallery.ts`, `messages.d.ts` (crawl tabId field) | Low | Low (crawl cancel — fixable) |

**Expected impact:** eliminates ~150M object reads (cancel cache) + ~303K tab
IPC round-trips (targeted broadcast) + reduces `originalItems` retention.
**~90% of the perf win without touching storage.**

### Phase 2 — options page + message slimming (no storage change)

| Fix | Files | Effort | Risk |
|---|---|---|---|
| 2 — slim progress messages | `gallery.ts`, `messages.d.ts`, `index.ts`, `tab-history.ts` | Medium | Low |
| 6 — pause polling | `index.ts` | Low | Low (with auto-resume) |

**Expected impact:** eliminates ~505K DOM node rebuilds + 3s polling fight.
Options page main-thread time drops from "frozen during crawl" to "responsive."

### Phase 3 — IndexedDB migration (storage change)

| Fix | Files | Effort | Risk |
|---|---|---|---|
| 4 — IDB jobs | new `idb.ts`, `job-store.ts`, `gallery.ts` (dedup), `tab-history.ts` | High | Medium (migration) |
| 5 — IDB logs + hybrid buffer | `logger.ts`, `idb.ts`, `tab-logs.ts` | Medium | Medium (debug-log loss on kill) |

**Expected impact:** eliminates ~350M object ser/deser (jobs) + ~10M (logs) +
turns dedup from 25M comparisons into 5K indexed gets. Unlocks skip-if-exists
via `[subfolder+displayName]` index.

### Phase 4 — skip-if-exists feature (builds on IDB)

| Feature | Files | Effort | Risk |
|---|---|---|---|
| Skip-if-exists | `gallery.ts` (pre-download check), options toggle | Low | None |

**Expected impact:** no re-downloads of files already in history. O(1) check
per item. Independent of `chrome.downloads` (which LO clears).

---

## 5. What we lose by not using `chrome.downloads.search` (Option G)

1. **No cross-tool dedup** — if you downloaded the same file manually via Save
   As, or via another extension, our IDB cache won't know. `chrome.downloads.search`
   would have caught those. But since you clear that history anyway, G was
   never going to work for you.

2. **No "file still on disk?" check** — `chrome.downloads.search` returns
   `exists: true/false` (is the file physically still there?). Our IDB cache
   only knows "we marked it done" — if you deleted the file from disk via
   Explorer, we'd still skip it. This is the same limitation the current
   dedup has, so no regression.

3. **Skip-cache retention = job retention** — only the last 50 completed jobs'
   items serve as skip-cache. If that's not enough, add a separate
   `downloadedFiles` store (keyPath `[subfolder+filename]`) that persists
   independently of the job cap. Deferred — see §3.3.

---

## 6. IDB caveats in MV3

1. **SW lifecycle** — IDB transactions keep the SW alive only while the
   transaction is open. Short transactions (single-record puts) complete in
   <1ms and don't prevent SW lifecycle. Long transactions (the GC cascade
   delete) should be chunked (delete in batches of 100, yield between).

2. **Supported in Chrome 109+ and Firefox MV3** — no issue for a modern
   extension. The `indexedDB` global is available in the SW context.

3. **No `storage.onChanged` events** — IDB doesn't fire
   `browser.storage.onChanged`. Currently nothing in the code listens for that
   (the options page uses `sendMessage` for live updates, not `onChanged`), so
   no regression. Worth noting if we ever want cross-context sync.

4. **Quota** — IDB has 50MB+ by default; with `"unlimitedStorage"` permission
   (manifest), effectively unlimited. The current `storage.local` is capped at
   10MB. For a crawl of 101 jobs × 50 items = 5,050 records, each ~200 bytes =
   ~1MB. Well within default quota. The `unlimitedStorage` permission is
   insurance for heavy users.

5. **Migration crash recovery** — if the migration crashes mid-way, the old
   `storage.local` keys are still there and IDB has partial data. The
   `count > 0` guard means the migration won't re-run. For a crashed partial
   migration, a manual `chrome.storage.local.remove("downloadJobs")` from the
   options page's dev console is the recovery path. (We could add a "Repair
   storage" button later if this becomes a real concern.)

---

## 7. The numbers — side by side

For a 101-gallery × 50-image crawl (~5,050 items, ~10,100 upserts, ~15,150
cancel checks, ~10,000 logs):

| Metric | Current (`storage.local`) | Phase 1+2 (no IDB) | Phase 3 (IDB) | Reduction (final) |
|---|---|---|---|---|
| Object ser/deser (jobs) | ~350M | ~350M (still full-array) | ~20K record writes | ~17,000× |
| Object ser/deser (logs) | ~10M | ~10M (still full-array) | ~10K record writes | ~1,000× |
| Dedup comparisons | ~25M | ~25M (still nested loop) | ~5,050 indexed gets | ~5,000× |
| Cancel-check reads | ~150M objects | 0 (cache) | 0 (cache) | ∞ |
| Tab IPC round-trips | ~303,000 | ~20,200 (options page only) | ~20,200 | ~15× |
| History-tab DOM rebuilds | ~505,000 | ~10,100 single-row patches | ~10,100 single-row patches | ~50× |
| History-tab list parse | ~10K objects / 3s | ~10K objects / 3s | ~1K objects / 3s | 10× |
| `storage.local` quota | 10MB | 10MB | 50MB+ (IDB) | 5×+ |

**Phase 1+2 (no IDB) captures ~90% of the user-visible win** (responsive
browser during crawl). **Phase 3 (IDB) captures the architectural win**
(storage sustainability + dedup + skip-cache) and unlocks the skip-if-exists
feature.

---

## 8. File-by-file change map

### Phase 1

| File | Changes |
|---|---|
| `src/background/gallery.ts` | Add `cancelledJobs: Set<string>` cache. Replace `readJobs()` cancel checks at `:169, :213, :237` with `cancelledJobs.has(jobId)`. Trim `originalItems` at `:418` before final upsert. Replace `broadcastProgressToTabs` with targeted tab delivery (crawl tabId stored on `MD_CRAWL_START`). |
| `src/background/job-store.ts` | `cancelJob` / `cancelAllJobs` / `clearAllJobs` add to `cancelledJobs` cache. |
| `src/types/messages.d.ts` | `MDCrawlStartRequest` gains optional `tabId?: number` for targeted broadcast. |

### Phase 2

| File | Changes |
|---|---|
| `src/types/messages.d.ts` | `MDJobProgressMessage` gains `itemDelta?: { idx: number; status; filename; error?; sourceUrl? }`. `items` field kept for backward compat during migration, then removed. |
| `src/background/gallery.ts` | `broadcastProgress` sends `itemDelta` (the one changed item) instead of `items` array. |
| `src/options/index.ts` | Live message handler: patch single row via `itemDelta` instead of `replaceChildren` + rebuild. Pause 3s interval on message, auto-resume after 10s quiet. |
| `src/options/tab-history.ts` | `renderJobCard` items container supports per-row patching (find row by `data-idx` attribute). |

### Phase 3

| File | Changes |
|---|---|
| `src/background/idb.ts` | **NEW.** Promise wrapper + schema + `openDB()` + transaction helpers. ~80 lines. |
| `src/background/job-store.ts` | Rewrite all functions against IDB. `readJobs` → `jobs.getAll()`. `upsertJob` → `jobs.put()` + `jobItems.put()`. `listJobs` → `jobs.index("startedAt").getAll()`. `deleteJob` → cascade via `jobItems.index("jobId")`. `clearAllJobs` → `jobs.clear()` + `jobItems.clear()`. `resumeJob` → `jobs.get(jobId)` + `originalItems` reconstruction from `jobItems`. `cancelJob` / `cancelAllJobs` → `jobs.get()` + mutate + `jobs.put()`. Migration on first run. |
| `src/background/gallery.ts` | Dedup at `:330-340` → `jobItems.index("[subfolder+displayName]").get()`. Skip-if-exists check before `attemptDownload`. |
| `src/background/logger.ts` | Rewrite against IDB `logs` store. Hybrid buffer: `debugLogBuffer` in SW memory, flush every 5s. Info/warn/error immediate. Cap GC on flush. |
| `src/options/tab-logs.ts` | `loadLogsTab` → `logs.index("ts").openCursor("prev")` + advance 500. |
| `src/options/tab-history.ts` | `loadHistoryTab` → `jobs.index("startedAt").getAll()` (metadata only). Expand card → `jobItems.index("jobId").getAll(jobId)`. |
| `src/background/index.ts` | Call `migrateIfNeeded()` on SW startup. |

### Phase 4

| File | Changes |
|---|---|
| `src/background/gallery.ts` | `isAlreadyDownloaded(subfolder, displayName)` check before `attemptDownload` in `runQueue`. If true, mark item done + skip. |
| `src/settings/schema.ts` | New `skipExistingFiles: boolean` toggle (default true). |
| `src/options/tab-downloads.ts` | UI toggle for skip-if-exists. |

---

## 9. Test plan

### Phase 1
- Unit: `cancelledJobs` cache — add on cancel, hit on `runQueue` check, miss on
  normal flow. SW restart → cache empty → `resumeRunningJobs` marks all as
  error (existing behavior, unchanged).
- Integration: crawl cancel still aborts in-flight API fetches (targeted tab
  broadcast delivers the cancel message to the right tab).
- Regression: `originalItems` present on canceled/error jobs (resume works),
  absent on done jobs.

### Phase 2
- Unit: `itemDelta` message → single-row DOM patch (find row by `data-idx`,
  update status icon + filename + error text). Full `items` message → full
  rebuild (backward compat).
- Integration: open options page mid-crawl → `loadHistoryTab` initial render
  shows all items (from `MD_LIST_JOBS`), then live patches work.
- Regression: 3s polling pauses on message, resumes after 10s quiet. SW-restart
  edge case: polling catches stale "running" job within 3s.

### Phase 3
- Unit: IDB schema creates stores + indexes on first open. `upsertJobItem`
  writes one record. `jobs.index("startedAt").getAll()` returns metadata only.
  `jobItems.index("[subfolder+displayName]").get([sub, name])` returns the
  right item. GC cascade deletes a job's items.
- Integration: migration — seed `storage.local` with 50 jobs + 500 logs, run
  migration, verify IDB has all data, verify old keys deleted. Re-run
  migration → no-op (`count > 0` guard).
- Regression: resume still works (IDB `jobs.get()` returns `originalItems` for
  canceled/error jobs). 50-job cap still trims (GC pass on "done" transition).
- Soak: 101-gallery crawl with IDB — verify no browser lag, verify SW memory
  stable (no `storagePromise`-equivalent chain growth).

### Phase 4
- Unit: `isAlreadyDownloaded` returns true for a file in a completed job,
  false for a file in a running job, false for a file not in any job.
- Integration: download a file, mark job done, trigger the same download again
  → skipped. Clear IDB → re-downloads.
- Regression: skip toggle off → downloads even if file is in history.

---

## 10. Open questions

1. **`originalItems` reconstruction for resume** — with IDB, `originalItems`
   is the pre-resolution `GalleryJobItem[]`. After Phase 3, should we
   reconstruct it from `jobItems` (which are post-resolution
   `DownloadJobItem[]`) or keep storing it separately? The current code uses
   `originalItems` for resume because `items` may have been mutated (filename
   overrides from extraction). With IDB, we could store the original
   `GalleryJobItem[]` as a blob on the job record (one field, never indexed)
   and keep `jobItems` as the per-item state. This preserves the current
   resume semantics without a reconstruction step. **Decision: store
   `originalItems` as a blob on the job record for canceled/error jobs;
   don't store it for done jobs (Fix 7).**

2. **`downloadedFiles` store for longer skip-cache retention** — deferred. The
   50-job cap may be too short for LO's use case (101-gallery crawl evicts the
   first 51). If this proves annoying, add a separate `downloadedFiles` store
   (keyPath `[subfolder+filename]`) that persists independently. ~1 extra
   record write per download. **Decision: start with the unified `jobItems`
   store, add `downloadedFiles` only if the 50-job cap proves too short.**

3. **IDB transaction chunking for GC cascade** — deleting 5,050 items in one
   transaction when the cap is exceeded could block other transactions.
   Chunk to 100 deletes per transaction, yield between. **Decision: chunk
   if the GC pass exceeds 100 records; otherwise single transaction.**

4. **`unlimitedStorage` permission** — needed? Default IDB quota is 50MB+,
   which is plenty for 50 jobs × 50 items + 500 logs. Add the permission as
   insurance for heavy users. **Decision: add it — it's free and avoids a
   quota surprise.**

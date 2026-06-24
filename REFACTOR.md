# REFACTOR — Gallery resolution pipeline & the girlsreleased aggregator

> Status: **PROPOSAL — not executed.** This document is the analysis + plan only.
> No source files have been changed. Author: architecture review, 2026-06-24.
> Scope: `src/background/gallery.ts`, `src/background/fetcher.ts`,
> `src/content/shared/gallery-runner.ts`, `src/hosts/girlsreleased/*`,
> `src/types/hoster.d.ts`, `src/types/messages.d.ts`. Bunkr and the other hosters
> are touched only by a backward-compatible type change.

---

## 0. TL;DR

The gallery resolution framework was designed around **one model = one site**, with a
clean two-step contract:

1. `extractFromViewer(html)` — parse the real media URL out of the viewer page the
   framework already fetched.
2. `resolveUrl(rawUrl)` — *transform* that URL (e.g. append a Bunkr sign token).

**girlsreleased breaks this contract.** It is an *aggregator* — its images live on
downstream hosts (imx.to, imagevenue, …) — so it has no `extractFromViewer`, and it
abuses `resolveUrl` as a "go fetch and parse a whole different page" hook that ignores
`rawUrl` entirely. The result is a pile of leaks:

- The framework still performs a full credentialed GET of every viewer page
  (`gallery.ts:144`) whose body is then **thrown away** for girlsreleased — ~69 wasted
  full-page fetches in a 69-image job.
- The `imagevenue` branch silently depends on that wasted GET as a **cookie-priming side
  effect** across two functions in two files — an invisible landmine.
- imx.to is resolved **two different ways** depending on entry path, set-name derivation
  is **duplicated**, and direct `/set/` pages have **different host coverage** than
  `/site/`-originated crawls (imagevenue is unreachable on direct `/set/` pages).

The fix is to make the contract honest by adding a third hook —
**`resolveFromViewer(viewerUrl)`** — for hosts that own their own fetching, and to route
all girlsreleased set resolution through the `/api/0.3/set/{id}` endpoint it already uses
for `/site/` crawls. This removes the wasted fetches, defuses the imagevenue landmine,
unifies the two collection paths, and lets the band-aids added in `gallery.ts:175-177`
be deleted. imx.to/imagevenue become shared **leaf resolvers** (a hostname-keyed
registry, §3.3) rather than girlsreleased-internals, so a second aggregator pointing at
the same hosts reuses them with zero duplication or cross-aggregator imports.

---

## 1. Current architecture (as-is)

### 1.1 Resolution pipeline (SW side)

`runQueue` (`gallery.ts:301`) pulls each `GalleryJobItem` and calls
`resolveItem(item, jobId, hosterId)` (`gallery.ts:137`, invoked at `gallery.ts:324`).
`resolveItem` is the single chokepoint and currently does:

```
1. item.kind === "resolved"        → return item.imageUrl           (no network)
2. GET viewer page  ─────────────► const { text } = fetchWithRetry(item.viewerUrl)   [gallery.ts:144]
3. extractFromViewer(text)         → rawUrl, filenameOverride        [gallery.ts:150-156]  (bunkr)
4. else regex(item.extractor, text)→ rawUrl                          [gallery.ts:158-164]  (generic)
5. resolveUrl(rawUrl, viewerUrl)   → final url (+filename)           [gallery.ts:175-185]  (bunkr/girlsreleased)
6. else                            → return rawUrl
```

Step 2 always runs for every `resolve-viewer` item, via `fetchWithRetry`
(`gallery.ts:103`) → `crossOriginFetchText` (`fetcher.ts:18`), which fetches with
`credentials: "include"` and `cache: "default"` (`fetcher.ts:32-36`).

The two hooks are defined in `hoster.d.ts`:

```ts
// hoster.d.ts:66
export type ExtractFromViewer = (html: string) => { url: string; filename?: string } | null;

// hoster.d.ts:70
export type ResolveUrl = (
  rawUrl: string,
  viewerUrl?: string,
) => Promise<string | { url: string; filename?: string }>;
```

Only `gallery.ts` calls them (one call site each: `:151` and `:177`). Implementations:
Bunkr (`extractFromBunkrViewer` + `signBunkrUrl`) and girlsreleased
(`resolveGirlsreleasedUrl`, no extractor).

### 1.2 The two consumers use the hooks in opposite ways

| Aspect | **Bunkr (intended)** | **girlsreleased (abuse)** |
| --- | --- | --- |
| `extractFromViewer` | parses real CDN URL from fetched HTML (`bunkr/model.ts:115`) | **absent** |
| `resolveUrl` primary input | `rawUrl` — signs it (`bunkr/model.ts:149`) | `viewerUrl` — re-fetches it |
| `rawUrl` usage in `resolveUrl` | the whole point | **ignored** (vestigial) |
| network inside `resolveUrl` | sign-API call *about* the URL | a full secondary page fetch |
| framework GET (step 2) body | **used** by `extractFromViewer` | **discarded** |

`signBunkrUrl(rawUrl)` (`bunkr/model.ts:149`) doesn't even accept `viewerUrl`;
`resolveGirlsreleasedUrl(rawUrl, viewerUrl)` (`girlsreleased/model.ts:64`) ignores
`rawUrl`. The single `ResolveUrl` signature is serving two incompatible mental models.

### 1.3 girlsreleased collection — two paths, two behaviors

**Path A — direct `/set/NNN` page** (`collectGirlsreleasedItems`, `girlsreleased/model.ts:4`):
DOM-scrapes anchors where `href.includes("imx.to/i/")` (`:44`) → `resolve-viewer` items
with `extractor: "continuebutton"` (`:54`). **imx.to only.** imagevenue images on the
page are silently dropped (and if a set is imagevenue-only, zero items are collected →
nothing happens).

**Path B — `/site/` page** (`collectGirlsreleasedItems` `isSitePage` branch `:19-37`,
then set expansion in `gallery-runner.ts:277-353`): collects `/set/` links → `hasSets`
true → fetches `/api/0.3/set/{id}` per set (`gallery-runner.ts:291`) → reads positional
JSON (`setArray[1]/[3]/[4]/[5]`, `file[3]/[4]/[5]`, `:298-318`). For each file:
- imx.to thumbnail (`thumbnailUrl.includes("/u/t/")`) → derive full URL by string-swap
  `/u/t/` → `/u/i/` and emit a **`resolved`** item, no network (`:326-332`).
- otherwise → emit a `resolve-viewer` item with `extractor: "continuebutton"` (`:333-341`).

So the **same set** yields different filenames (API `originalFilename` vs viewer
`<title>`), different request counts, and different host support depending on whether you
reached it directly or via `/site/`.

---

## 2. Findings

Severity: **H** = correctness/perf landmine, **M** = real smell w/ maintenance cost,
**L** = cosmetic.

### F1 — `imagevenue` branch depends on an invisible cookie side effect  ·  **H**

`girlsreleased/model.ts:98-119`:

```ts
if (viewerUrl.includes("imagevenue.com")) {
  // ImageVenue has an interstitial on first fetch. The SW already did one GET
  // (in resolveItem), so cookies should be set. Second fetch gets the real page.
  const res = await fetch(viewerUrl, { credentials: "include" });
  ...
}
```

- **Hidden cross-function/cross-file coupling.** This works only because
  `resolveItem` (`gallery.ts:144`) already did a `credentials: "include"` GET of the same
  URL, priming the interstitial cookie in the SW cookie jar. Nothing in the type or the
  call expresses this dependency.
- **The primed GET's body is discarded** (no `extractFromViewer`; the generic regex runs
  `new RegExp("continuebutton")` which has no capture group and never matches —
  `gallery.ts:158-164`). So we fetch the page, throw it away, then fetch it **again**.
- **Landmine:** the obvious optimization "skip the viewer GET when there's no
  `extractFromViewer`" (the body is unused) would silently break imagevenue while leaving
  imx.to working.
- **Cache hazard:** GET #1 (`cache: "default"`) and GET #2 (no `cache` option → also
  `"default"`) are identical requests; if imagevenue serves a cacheable interstitial, GET
  #2 can be served the cached interstitial. No `cache: "reload"` forces revalidation.
- **Reachability:** imagevenue items only arise via Path B; on a direct `/set/` page
  imagevenue is unsupported (see F6).

### F2 — `resolveUrl` has two opposite meanings; the framework GET is wasted  ·  **H**

The dual-use described in §1.2. Concrete cost: for **every** imx.to item, `resolveItem`
does a full credentialed GET (`gallery.ts:144`) whose body is discarded, then
`resolveGirlsreleasedUrl` does a separate POST that sends **no** credentials
(`fetch(viewerUrl, { method: "POST", … })`, `girlsreleased/model.ts:74` — default
`credentials: "same-origin"` ⇒ no cookies cross-origin). The framework GET is therefore
*wasted* for imx.to but *load-bearing* (cookies) for imagevenue — the GET's purpose is
host-dependent and implicit. The guard `if (gc?.resolveUrl && (rawUrl || !gc.extractFromViewer))`
and `gc.resolveUrl(rawUrl ?? "", …)` (`gallery.ts:175-177`) are band-aids over this seam.

### F3 — girlsreleased is an aggregator modeled as a single hoster  ·  **H**

`HosterModel` (`hoster.d.ts:103`) assumes one model = one site. girlsreleased's images
live on downstream hosts, so `resolveGirlsreleasedUrl` is a mini host-dispatcher
(`if imx.to / if imagevenue / else`, `:70/:98/:121`) embedded in one model. There is no
first-class notion of "this item's real host differs from the gallery host," so
downstream resolution logic can't be shared or tested in isolation.

### F4 — imx.to resolved two ways  ·  **M**

- API path: thumbnail string-swap `/u/t/` → `/u/i/`, no network (`gallery-runner.ts:326-332`).
- Viewer path: POST `imgContinue`, scrape `<img src>` (`girlsreleased/model.ts:70-95`).

These are two strategies for the same host living in two worlds (MAIN vs SW). Not
strictly redundant (different inputs), but imx.to knowledge is scattered with no single
owner.

### F5 — set-name / subfolder derivation duplicated  ·  **M**

`getGalleryName` derives `Site/Model - SetName` by DOM scraping
(`girlsreleased/model.ts:153-202`); the API crawl derives the same shape from JSON
(`gallery-runner.ts:298-312`). Two implementations of one naming convention.
NB: `getGalleryName` is a shared hook (6 hosters + `downloader.ts:15-25`), so it **cannot
be deleted** — only the girlsreleased-local duplication should be unified.

### F6 — entry-path coverage asymmetry  ·  **M**

Direct `/set/NNN` (Path A) supports imx.to only and uses viewer-`<title>` filenames;
`/site/`-originated crawl (Path B) supports imx.to + imagevenue + fallback and uses API
`originalFilename`. The richer Path B is not used for the most common user action
(opening a set directly).

### F7 — vestigial `extractor: "continuebutton"`  ·  **M**

`messages.d.ts:56` makes `extractor` **required** on `resolve-viewer` items. girlsreleased
has no regex extractor, so it sets the placeholder `"continuebutton"`
(`girlsreleased/model.ts:30,54`; `gallery-runner.ts:337`) purely to satisfy the type —
the same species of dead sentinel as the `"dummy"` removed earlier. It is never used
(the generic regex never matches).

### F8 — magic positional JSON indices  ·  **M**

`setArray[1]/[3]/[4]/[5]`, `file[3]/[4]/[5]` (`gallery-runner.ts:298-318`) parse the
`/api/0.3/set/` response with untyped positional access and no schema. One API reshuffle
silently mis-parses (wrong site name, wrong file URL).

### F9 — substring host/path matching  ·  **L**

`viewerUrl.includes("imx.to/i/")`, `includes("imagevenue.com")`, `includes("/set/")`,
`thumbnailUrl.includes("/u/t/")` (multiple sites). Substring matching misfires on query
strings (`?ref=imagevenue.com`) and lookalike hosts. Low security risk for a personal
tool, but fragile.

### F10 — minor  ·  **L**

- `getModel(hosterId as never)` (`gallery.ts:140`) — cast to defeat the union-typed param.
- `collectGirlsreleasedItems` falls back to `window.location`/`document` globals for
  `isSitePage` (`girlsreleased/model.ts:6`) — works (mitigated by the `root` param) but
  couples collection to MAIN-world globals.

### What is NOT broken (do not touch)

The ISOLATED↔MAIN CustomEvent bridge, the message-type definitions, Bunkr's
`extractFromViewer` as a pure `html → {url}` boundary, and the
`thumbnail-transform`/`anchor-href` strategies for simple hosters are clean. The rot is
concentrated in girlsreleased because it does something (aggregation) the model was never
shaped for.

---

## 3. Target architecture

### 3.1 Three honest hooks instead of two overloaded ones

Add a third hook to `GalleryConfig` for hosts that own their own fetching:

```ts
// hoster.d.ts — NEW
// A resolve-viewer item whose URL must be derived by the host itself (it fetches
// the viewer page however it needs to — POST interstitial, credentialed GET, etc.).
// When present, the framework does NOT pre-fetch the viewer page; this hook is the
// sole authority. Mutually exclusive with extractFromViewer in practice.
export type ResolveFromViewer = (
  viewerUrl: string,
) => Promise<{ url: string; filename?: string }>;
```

Final contract, by host shape:

| Host shape | hook used | framework GET? | example |
| --- | --- | --- | --- |
| extract + transform | `extractFromViewer` then `resolveUrl` | **yes** (body used) | Bunkr |
| self-resolving | `resolveFromViewer` | **no** | girlsreleased |
| plain regex | `imageSource.extractor` | yes | (generic) |

### 3.2 `resolveItem` pipeline (proposed)

```ts
async function resolveItem(item, jobId, hosterId): Promise<string> {
  if (item.kind === "resolved") return item.imageUrl;

  const gc = getModel(hosterId)?.galleryConfig;

  // Self-resolving hosts own their fetching — no wasted framework GET.
  if (gc?.resolveFromViewer) {
    const { url, filename } = await gc.resolveFromViewer(item.viewerUrl);
    if (filename) item.filename = filename;
    return url;
  }

  // Extract + (optional) transform hosts.
  void appendLog("debug", `Fetching viewer: ${item.viewerUrl}`, jobId);
  const { text } = await fetchWithRetry(item.viewerUrl, jobId, "viewer page");

  let rawUrl = gc?.extractFromViewer?.(text)?.url?.replace(/\\/g, "");
  // … filename override, generic regex fallback (unchanged) …
  if (!rawUrl) { /* error */ }

  if (gc?.resolveUrl) return finalize(await gc.resolveUrl(rawUrl, item.viewerUrl), item);
  return rawUrl;
}
```

Net effects: the `rawUrl ?? ""` and the `(rawUrl || !gc.extractFromViewer)` guard
(`gallery.ts:175-177`) are **deleted**; Bunkr's path is byte-for-byte unchanged; the
girlsreleased viewer GET disappears entirely.

### 3.3 Leaf-resolver registry — imx.to / imagevenue are first-class & shared

**Decision:** imx.to and imagevenue are NOT girlsreleased-internal, and NOT full
`HosterModel`s either. They are a third tier — **leaf resolvers**: shared, hostname-keyed
resolvers for hosts we only ever *resolve* (never inject content scripts on; no gallery,
no redirect rules). This is the answer to "what happens when a second aggregator points at
the same host" — it dispatches into the same registry, zero duplication, zero
cross-aggregator imports.

| Tier | Examples | Activates on site? | Shape |
| --- | --- | --- | --- |
| HosterModel | imagebam, bunkr, jpg6 | yes (content scripts, gallery) | full `HosterModel` |
| Aggregator | girlsreleased | yes, but images live elsewhere | `HosterModel` that dispatches to leaf resolvers |
| **Leaf resolver** | **imx.to, imagevenue** | **no — resolve-only** | lightweight `LeafResolver` |

New `src/resolvers/`:

```ts
// resolvers/types.ts
export type LeafResolver = {
  id: string;
  matches: (url: URL) => boolean;                       // hostname match, not substring (F9)
  resolveFromViewer: (viewerUrl: string) => Promise<{ url: string; filename?: string }>; // SW-only (fetch)
  fromThumbnail?: (thumbUrl: string) => string | null;  // pure transform, MAIN-safe (imx /u/t/→/u/i/)
};

// resolvers/index.ts
export const LEAF_RESOLVERS: LeafResolver[] = [imxResolver, imagevenueResolver];

export async function resolveLeaf(viewerUrl: string): Promise<{ url: string; filename?: string }> {
  const u = new URL(viewerUrl);
  const r = LEAF_RESOLVERS.find((r) => r.matches(u));
  if (!r) throw new Error(`no leaf resolver for host: ${u.hostname}`); // replaces silent return rawUrl (F-OQ3)
  return r.resolveFromViewer(viewerUrl);
}

export function thumbnailToFull(thumbUrl: string): string | null {
  const u = new URL(thumbUrl);
  return LEAF_RESOLVERS.find((r) => r.matches(u))?.fromThumbnail?.(thumbUrl) ?? null;
}
```

- `resolvers/imx.ts` — `resolveFromViewer` (POST `imgContinue`, scrape `<img>`) +
  `fromThumbnail` (`/u/t/`→`/u/i/`). **Single owner** for both imx.to strategies (kills F4).
- `resolvers/imagevenue.ts` — `resolveFromViewer` that self-primes its own cookie (§3.5).

Wiring: `girlsreleasedModel.resolveFromViewer = resolveLeaf`; the API crawl
(`gallery-runner.ts`) calls `thumbnailToFull(file.thumbnailUrl)` first, then falls back to
a `resolve-viewer` item. A future aggregator wires the *same* `resolveLeaf`.

**Pays off with one aggregator already:** single owner for imx.to (F4) + explicit
unsupported-host error instead of the silent `return rawUrl` (`model.ts:121`). The
multi-aggregator reuse is the bonus, not the sole justification.

**Why not just a `HosterModel`?** Its required fields (`viewerMatches`, `cdnMatches`,
`defaultRedirectRules`, `downloadConfig`, `defaultCssOverrides`, `galleryConfig`) are all
meaningless for a resolve-only host — forcing them recreates the dead-sentinel smell
(`dummy`/`continuebutton`) we are removing. `LeafResolver` carries only what such a host
actually has.

### 3.4 API-first set resolution (unify Path A and Path B)

Route direct `/set/NNN` pages through the same `/api/0.3/set/{id}` expansion used for
`/site/`. Mechanism: when `collectGirlsreleasedItems` runs on a `/set/NNN` page, emit a
**single** `resolve-viewer` item pointing at the set's own URL, so the existing
`hasSets` expansion (`gallery-runner.ts:277`) takes over:

```ts
// girlsreleased/model.ts — /set/NNN page
return [{ kind: "resolve-viewer", viewerUrl: location.href, /* extractor optional */ }];
// → hasSets sees "/set/" → /api/0.3/set/NNN → real items (imx.to + imagevenue + filenames)
```

This deletes the DOM-scrape imx.to-only branch (`:39-58`), closes F6, and makes
imagevenue reachable on direct pages.

### 3.5 imagevenue made self-sufficient (kills F1)

`imagevenueResolveFromViewer` does **both** fetches itself — no dependency on a framework
GET that no longer happens:

```ts
async function imagevenueResolveFromViewer(viewerUrl) {
  await fetch(viewerUrl, { credentials: "include", cache: "no-store" }); // prime cookie
  const res = await fetch(viewerUrl, { credentials: "include", cache: "reload" }); // real page
  // … parse <img> / og:image … (logic moved verbatim from model.ts:98-118)
}
```

`cache: "no-store"`/`"reload"` removes the cache hazard. The coupling is gone because the
host explicitly performs its own priming.

### 3.6 Typed set API response (kills F8)

```ts
// girlsreleased/api.ts
type RawSet = [id: number, name: string, _x: unknown, site: string, files: RawFile[], models: [number, string][]];
type RawFile = [_a: unknown, _b: unknown, _c: unknown, viewerUrl: string, thumbnailUrl: string, originalFilename: string];

export function parseSet(json: unknown): {
  name: string; site: string; model: string;
  files: { viewerUrl: string; thumbnailUrl: string; filename: string }[];
} | null;
```

One validated parse, named fields, used by both the crawl and (now) direct `/set/` pages.

### 3.7 `extractor` becomes optional (kills F7)

```ts
// messages.d.ts
| { kind: "resolve-viewer"; viewerUrl: string; extractor?: string; filename: string; subfolder?: string };
```

`gallery.ts` only reads `item.extractor` in the generic-regex fallback, guarded by
`if (gc?.extractFromViewer) … else if (item.extractor) …`. Then drop every
`extractor: "continuebutton"`.

---

## 4. Phased implementation plan

Each phase is independently shippable and leaves `bun run check` + `bun test` green.

### Phase 1 — introduce `resolveFromViewer`, rewrite the pipeline  (H-value, low risk)
- `hoster.d.ts`: add `ResolveFromViewer` type + `resolveFromViewer?` on `GalleryConfig`.
- `gallery.ts`: rewrite `resolveItem` per §3.2; delete the `:175-177` band-aids.
- `girlsreleased/model.ts`: rename `resolveGirlsreleasedUrl` → `resolveGirlsreleasedFromViewer(viewerUrl)`
  (drop the `rawUrl` param + the trailing `return rawUrl` fallback); wire as
  `resolveFromViewer`. Behavior identical except the wasted GET is gone.
- **Test:** existing `girlsreleased.test.ts` calls `resolveUrl!("continuebutton", url)` —
  update to `resolveFromViewer!(url)`. Add a test asserting no viewer GET happens
  (mock `fetch`, assert call count).
- **Risk:** Bunkr path must be untouched — assert via its absence from the diff + `bun test`.

### Phase 2 — leaf-resolver registry  (M-value, low risk)
- New `src/resolvers/{types,index,imx,imagevenue}.ts` (§3.3); move imx.to + imagevenue
  logic out of `model.ts` into shared leaf resolvers. Wire
  `girlsreleasedModel.resolveFromViewer = resolveLeaf`; `gallery-runner` uses
  `thumbnailToFull(...)`. Hostname parsing replaces substring matches (F9). Unmatched
  host → explicit error, not silent `return rawUrl`.
- **Test:** unit-test `imxResolver.fromThumbnail`, `resolveLeaf` dispatch + unmatched-host
  error, hostname edge cases (`?ref=imagevenue.com`, lookalike domains).

### Phase 3 — imagevenue self-priming  (H-value, medium risk)
- Implement §3.5 inside `imagevenueResolveFromViewer`; remove the dependency comment.
- **Risk:** needs live verification against imagevenue (interstitial behavior). Until
  verified, keep behind the existing flow. **Manual test required** (see §6).

### Phase 4 — API-first `/set/` + typed API  (H-value, medium risk)
- `girlsreleased/api.ts` with `parseSet` (§3.6); refactor `gallery-runner.ts:277-353` to
  use it (kills magic indices).
- `collectGirlsreleasedItems`: `/set/NNN` → single self-referential set item (§3.4);
  delete the imx.to-only DOM scrape.
- Unify set-name derivation: have `parseSet` feed both the crawl and a thin
  `getGalleryName` (keep the hook; dedupe the body).
- **Test:** `girlsreleased.test.ts` — assert a `/set/` page produces one set item that
  expands via a mocked `/api/0.3/set/` response covering imx.to-thumbnail, imx.to-viewer,
  and imagevenue files.

### Phase 5 — retire `extractor`/`continuebutton`  (M-value, low risk)
- `messages.d.ts`: make `extractor` optional (§3.7); guard the read in `gallery.ts`;
  remove all `"continuebutton"` literals.
- **Risk:** other hosters using the generic regex strategy must still pass `extractor`
  via `imageSource` — verify none rely on the item-level field implicitly.

---

## 5. Type & contract changes (summary diff)

```diff
# hoster.d.ts
+ export type ResolveFromViewer = (viewerUrl: string) => Promise<{ url: string; filename?: string }>;
  export type GalleryConfig = {
    ...
    extractFromViewer?: ExtractFromViewer;
    resolveUrl?: ResolveUrl;
+   resolveFromViewer?: ResolveFromViewer;   // self-fetching hosts; framework skips the viewer GET
  };

# messages.d.ts
- | { kind: "resolve-viewer"; viewerUrl: string; extractor: string;  filename: string; subfolder?: string };
+ | { kind: "resolve-viewer"; viewerUrl: string; extractor?: string; filename: string; subfolder?: string };
```

`ResolveUrl` and `ExtractFromViewer` are **unchanged** (Bunkr keeps using them).

---

## 6. Testing & verification

- **Unit (`bun test`)** — extend `girlsreleased.test.ts`: `resolveFromViewer` for imx.to
  (POST mock), imagevenue (two-fetch mock asserting self-priming), `parseSet` shapes,
  `imxFullFromThumbnail`, hostname dispatch, and "no framework GET for self-resolving
  hosts."
- **Type gate** — `bun run check` (fmt + oxlint + tsc over src + tests + vite.config) must
  stay green at every phase.
- **Manual (required for Phase 3 & 4)** — load `build/chrome`, run a real
  `girlsreleased.com/set/NNN` that is imx.to-hosted (regression) **and** one that is
  imagevenue-hosted (new coverage), plus a `/site/` crawl. Confirm filenames, subfolder
  names, and that request count per imx.to item drops from 2 → 1.

---

## 7. Risk register

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Bunkr regression | low | Bunkr path unchanged; covered by `bun test` + diff review |
| imagevenue interstitial behaves differently than assumed | med | Phase 3 gated on live manual test; keep old flow until confirmed |
| `/api/0.3/set/` shape differs from assumed indices | med | `parseSet` validates + returns `null` on mismatch; log + skip |
| Dropping the framework GET breaks a host that relied on its cookie | low | Only girlsreleased relied on it (imagevenue), now self-priming |
| `extractor` optionalization breaks a generic-regex host | low | Audit: only girlsreleased used the item-level placeholder |

## 8. Non-goals

- No change to the ISOLATED/MAIN bridge, message transport, or download mechanics.
- imx.to/imagevenue are **not** modeled as full top-level `HosterModel`s — that is the
  wrong shape (resolve-only hosts; every required model field would be dead). They become
  shared **leaf resolvers** instead (§3.3). This is deliberate, and is exactly what lets a
  second aggregator reuse them without ugly hacks.
- No (yet) folding of Bunkr's own `extractFromViewer`/`resolveUrl` into the leaf registry
  — see open question 1.
- No retry/backoff changes.

## 9. Open questions

1. **Unify Bunkr into the leaf registry?** Bunkr also resolves a viewer page to a media
   URL. Should its logic become a `LeafResolver` so HosterModels and aggregators share one
   mechanism? Bunkr needs the framework GET + a sign step, so `LeafResolver` would need a
   transform variant first — defer until a real second consumer justifies it.
2. **Promote a leaf resolver to a HosterModel on demand?** If users ever land on
   `imx.to/i/` directly, wrap `imxResolver` in a thin `HosterModel` that *delegates* to the
   leaf resolver, rather than duplicating its logic.
3. **`/api/0.3/` stability** — is the version pinned by the site, or should `parseSet`
   defensively support multiple response shapes?
4. **Unsupported downstream hosts** — *(resolved by §3.3)* `resolveLeaf` throws an explicit
   "no leaf resolver for host" error instead of the silent `return rawUrl` fallback
   (`model.ts:121`). Adding a host = add one `LeafResolver`.

## 10. Suggested PR sequence

1. PR1 = Phase 1 (pipeline + `resolveFromViewer`) — biggest leverage, self-contained.
2. PR2 = Phase 2 + 5 (downstream module + extractor cleanup).
3. PR3 = Phase 4 (API-first + typed API) — needs manual verification.
4. PR4 = Phase 3 (imagevenue self-priming) — needs live imagevenue verification.

---

## Appendix A — file / call-site inventory

| Symbol | Defined | Called |
| --- | --- | --- |
| `resolveItem` | `gallery.ts:137` | `gallery.ts:324` (runQueue) |
| viewer GET | `gallery.ts:144` → `fetcher.ts:18` | always, per resolve-viewer item |
| `extractFromViewer` | bunkr `:115` | `gallery.ts:151` only |
| `resolveUrl` | bunkr `:149`, girlsreleased `:64` | `gallery.ts:177` only |
| `resolveFromViewer` (new) | girlsreleased (proposed) | `gallery.ts` (proposed) |
| `collectAllItems` | bunkr/erome/jpg6/imgbb/girlsreleased | `gallery-runner.ts:156,227` |
| `getGalleryName` | 6 hosters | `gallery-runner.ts:218`, `downloader.ts:15-25` |
| set API parse | inline `gallery-runner.ts:295-318` | (proposed: `api.ts:parseSet`) |
| imx thumb-swap | `gallery-runner.ts:326-332` | (proposed: `resolvers/imx.ts`) |
| leaf-resolver registry (new) | (proposed: `resolvers/index.ts`) | girlsreleased + future aggregators |
| `"continuebutton"` | `model.ts:30,54`, `gallery-runner.ts:337` | nowhere (vestigial) |

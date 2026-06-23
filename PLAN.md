# Clanker Media Downloader — Implementation Plan

## 1. Current State: Userscript Codebase Analysis

### 1.1 imgbam_dl.js (v2.0) — Most mature

- Matches `imagebam.com/image/*` and `imagebam.com/view/*`
- Downloads via `GM_xmlhttpRequest({ responseType: 'blob' })` — full re-download, not cache-aware
- Hijacks existing download button; injects spinner + status text next to `span.name.text-ellipsis`
- Smart filename: if server-assigned name is UUID-shaped, fall back to URL slug (or its numeric segment via v1Regex)

### 1.2 imgbox_dl.js (v1.2)

- Matches `imgbox.com/*` — too broad, also hits gallery and homepage
- Uses `GM_download` — re-download, no cache
- Spinner by converting `.icon-cloud-download` element inline; verbose inline-style manipulation

### 1.3 imgbb_dl.js (v0.1) — Least mature

- Matches `ibb.co/*`; uses jQuery for no reason
- `GM_download` only, zero feedback UI
- Key difference: displayed image is a compressed preview; download URL is the full-res at `i.ibb.co/...` — a different resource, so cache-hit is not expected

### 1.4 regex.md — Redirector companion rules

Documents CDN URL → viewer page redirect patterns for each hoster. These were originally intended as rules for the "Redirector" browser extension. **We are absorbing this capability into our extension directly**, with user-overridable defaults per hoster — making the Redirector extension unnecessary as a companion.

Use case: user is on a message board; an image is linked bare (not wrapped in proper BBcode). Right-click → Open Image in New Tab → extension intercepts the CDN URL navigation → redirects to the proper hoster viewer page → download button is already active.

---

## 2. The Bandwidth Problem

`GM_download` / `GM_xmlhttpRequest` run in Tampermonkey's privileged process context — a separate cache partition from the page. Even passing `img.src` directly still results in a new network request.

**Extension solution:** Background service worker with `host_permissions` + `fetch(url, { cache: 'force-cache' })`. SW fetches from the extension's own cache partition; first download is a full request, subsequent downloads of the same URL are served from SW cache. SW returns `ArrayBuffer + contentType`; content script assembles blob + triggers anchor download. No `chrome.downloads` API needed.

See §7 (Message Protocol) and §8 (Shared Modules) for implementation.

---

## 3. Core Concept: The Hoster Model

Each image hosting site is represented as a **HosterModel** — a self-contained definition of everything the extension needs to know about that site. Models are the single source of truth for defaults; the settings layer sits on top allowing user overrides.

```typescript
// src/types/hoster.d.ts

export type HosterId = 'imagebam' | 'imgbox' | 'imgbb';

export type RedirectRule = {
  id: string;            // stable slug for user override keying, e.g. "imagebam-new"
  description: string;   // shown in settings UI
  pattern: string;       // regex string (RE2-compatible for DNR; also run in JS)
  template: string;      // redirect URL template — $1/$2 for capture groups
  enabled: boolean;
};

export type FilenameStrategy =
  | { type: 'dom'; selector: string; attr?: string }     // read from DOM
  | { type: 'url-slug' }                                  // last path segment
  | { type: 'uuid-fallback'; domSelector: string };       // imgbam logic

export type DownloadConfig = {
  buttonSelector: string;
  imageSelector?: string;
  filenameStrategy: FilenameStrategy;
  uiMode: 'inline-after' | 'button-overlay';  // where to attach feedback UI
  pathGuard?: string;                           // runtime regex on pathname (imgbox)
};

export type HosterModel = {
  id: HosterId;
  displayName: string;
  viewerMatches: string[];          // manifest content_scripts matches (viewer pages)
  cdnMatches: string[];             // manifest content_scripts matches (CDN domains, for redirect)
  defaultRedirectRules: RedirectRule[];
  downloadConfig: DownloadConfig;
  defaultCssOverrides: string;      // empty string if none
};
```

### 3.1 Default model definitions

Each lives in `src/hosts/{id}/model.ts`, imported by both the content scripts and the settings page.

#### ImageBam

```typescript
export const imagebamModel: HosterModel = {
  id: 'imagebam',
  displayName: 'ImageBam',
  viewerMatches: [
    'https://www.imagebam.com/image/*',
    'https://www.imagebam.com/view/*',
  ],
  cdnMatches: [
    'https://thumbs*.imagebam.com/*',
    'https://images*.imagebam.com/*',
  ],
  defaultRedirectRules: [
    {
      id: 'imagebam-new',
      description: 'New format (uppercase ID, _o/_t suffix)',
      pattern: '^https?://(?:thumbs|images)\\d+\\.imagebam\\.com(?:/[a-f0-9]{2}){3}/([A-Z0-9]{7,})_[ot]\\.(gif|jpe?g|png)$',
      template: 'https://www.imagebam.com/view/$1',
      enabled: true,
    },
    {
      id: 'imagebam-old',
      description: 'Old format (lowercase ID, no suffix)',
      pattern: '^https?://(?:images|thumbs)\\d\\.imagebam\\.com/(?:[a-f0-9]{2}/){3}([a-z0-9]+)\\.(png|jpe?g|gif)$',
      template: 'https://www.imagebam.com/image/$1',
      enabled: true,
    },
  ],
  downloadConfig: {
    buttonSelector: 'a.dropdown-item[target="_blank"]',
    imageSelector: 'img.main-image',
    filenameStrategy: { type: 'uuid-fallback', domSelector: 'span.name.text-ellipsis' },
    uiMode: 'inline-after',
  },
  defaultCssOverrides: '',
};
```

#### ImgBox

```typescript
export const imgboxModel: HosterModel = {
  id: 'imgbox',
  displayName: 'ImgBox',
  viewerMatches: ['https://imgbox.com/*'],
  cdnMatches: [
    'https://thumbs*.imgbox.com/*',
    'https://images*.imgbox.com/*',
  ],
  defaultRedirectRules: [
    {
      id: 'imgbox-main',
      description: 'Thumbnail/image CDN redirect',
      pattern: '^https?://(?:thumbs|images)\\d+\\.imgbox\\.com(?:/[a-f0-9]{2}){2}/([a-zA-Z0-9]{8,})_[bot]\\.(gif|jpe?g|png)$',
      template: 'https://imgbox.com/$1',
      enabled: true,
    },
  ],
  downloadConfig: {
    buttonSelector: '.icon-cloud-download',
    imageSelector: '#img',
    filenameStrategy: { type: 'dom', selector: '.image-content', attr: 'title' },
    uiMode: 'button-overlay',
    pathGuard: '^/[a-zA-Z0-9]{8}$',
  },
  defaultCssOverrides: '',
};
```

#### ImgBB

```typescript
export const imgbbModel: HosterModel = {
  id: 'imgbb',
  displayName: 'ImgBB',
  viewerMatches: ['https://ibb.co/*'],
  cdnMatches: [],   // imgbb thumbnails on external sites link to ibb.co viewer directly — no CDN redirect needed
  defaultRedirectRules: [],
  downloadConfig: {
    buttonSelector: 'a.btn-download',
    filenameStrategy: { type: 'dom', selector: 'a.btn-download', attr: 'download' },
    uiMode: 'button-overlay',
  },
  defaultCssOverrides: '',
};
```

---

## 4. Settings Schema

**Principle:** Store only user overrides. Never store defaults. Merging defaults + overrides at runtime means new extension versions automatically ship improved defaults to users who haven't overridden them.

```typescript
// src/types/global.d.ts

export type HosterId = 'imagebam' | 'imgbox' | 'imgbb';

// Stored in browser.storage.local — overrides only
export type HosterOverride = {
  enabled: boolean;                         // always stored (default true)
  redirectRules: RedirectRule[] | null;     // null = "use model defaults"
  cssOverrides: string;                     // empty string = none
};

export type Settings = {
  enabled: boolean;
  hosters: Record<HosterId, HosterOverride>;
};

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  hosters: {
    imagebam: { enabled: true, redirectRules: null, cssOverrides: '' },
    imgbox:   { enabled: true, redirectRules: null, cssOverrides: '' },
    imgbb:    { enabled: true, redirectRules: null, cssOverrides: '' },
  },
};
```

**Runtime rule resolution:**

```typescript
// src/settings/resolve.ts
import type { HosterModel } from '../types/hoster';
import type { HosterOverride, RedirectRule } from '../types/global';

export function effectiveRules(model: HosterModel, override: HosterOverride): RedirectRule[] {
  return (override.redirectRules ?? model.defaultRedirectRules).filter(r => r.enabled);
}
```

---

## 5. Redirect Mechanism

**Not** `declarativeNetRequest` static rules — those can't be updated from user overrides at runtime.

**Approach:** Dedicated redirector content script injected on CDN domains at `document_start`. At that point the page is just a raw CDN image URL. The script reads the current effective redirect rules, tests the current `location.href`, and fires `location.replace(resolvedUrl)` if matched.

```typescript
// src/content/redirector.ts  (ISOLATED world, document_start)

import browser from 'webextension-polyfill';
import { ALL_MODELS } from '../hosts/index';
import { DEFAULT_SETTINGS } from '../settings/schema';
import { effectiveRules } from '../settings/resolve';

async function run(): Promise<void> {
  const stored = await browser.storage.local.get(DEFAULT_SETTINGS) as Settings;
  if (!stored.enabled) return;

  const href = location.href;
  for (const model of ALL_MODELS) {
    const override = stored.hosters[model.id];
    if (!override.enabled) continue;

    for (const rule of effectiveRules(model, override)) {
      const re = new RegExp(rule.pattern, 'i');
      const m  = re.exec(href);
      if (!m) continue;

      const target = rule.template.replace(/\$(\d+)/g, (_, n) => m[Number(n)] ?? '');
      location.replace(target);
      return;
    }
  }
}

run().catch(() => {});
```

**Timing:** `document_start` in ISOLATED world. Storage is async but since the page being intercepted is a raw CDN image URL, the brief delay before the `await` resolves is imperceptible — the browser is still loading the image bytes. By the time storage resolves (~1–5ms), the redirect fires before any image renders.

**Manifest content script entry for CDN domains:**

```jsonc
{
  "matches": [
    "https://*.imagebam.com/*",
    "https://*.imgbox.com/*"
  ],
  "js": ["src/content/redirector.ts"],
  "run_at": "document_start",
  "world": "ISOLATED"
}
```

This is in addition to the viewer-page content scripts. CDN domain URLs are already covered by `host_permissions`.

**User override flow:**
```
User updates redirect rule in options page
  → settings saved to browser.storage.local
  → next time user navigates to CDN URL
  → redirector.ts reads fresh settings
  → new pattern applied
```

---

## 6. CSS Override Mechanism

Per-hoster CSS overrides are injected into viewer pages via the ISOLATED world content script before the page renders.

```typescript
// In content/isolated.ts, after loading settings:
const override = settings.hosters[matchedModel.id];
if (override.cssOverrides) {
  const style = document.createElement('style');
  style.textContent = override.cssOverrides;
  (document.head ?? document.documentElement).appendChild(style);
}
```

Applied at `document_start` so overrides take effect before page CSS paints.

---

## 7. Message Protocol

```typescript
// src/types/messages.d.ts

type MDFetchBlobRequest = {
  type: 'MD_FETCH_BLOB';
  url: string;
};

type MDFetchBlobResponse =
  | { buffer: ArrayBuffer; contentType: string }
  | { error: string };

// MAIN → ISOLATED (window.postMessage)
type MDMainRequest = {
  type: 'MD_REQUEST';
  id: string;
  url: string;
};

// ISOLATED → MAIN (window.postMessage)
type MDMainResponse = {
  type: 'MD_RESPONSE';
  id: string;
  result: MDFetchBlobResponse;
};
```

**Flow:**
```
MAIN world
  → postMessage({ type: 'MD_REQUEST', id, url })
    → isolated.ts listens → browser.runtime.sendMessage({ type: 'MD_FETCH_BLOB', url })
      → background SW: fetch(url, { cache: 'force-cache' }) → ArrayBuffer
      → returns { buffer, contentType }
    → isolated.ts: postMessage({ type: 'MD_RESPONSE', id, result }, '*', [result.buffer])
  → MAIN world receives → Blob → createObjectURL → <a download> click
```

`ArrayBuffer` passed as a transferable — zero-copy across the ISOLATED→MAIN boundary.

---

## 8. Shared Modules

### 8.1 `src/background/fetcher.ts`

```typescript
export async function crossOriginFetchBlob(url: string): Promise<{ buffer: ArrayBuffer; contentType: string }> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Blocked: ${parsed.protocol}`);

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, { credentials: 'omit', cache: 'force-cache', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { buffer: await res.arrayBuffer(), contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
  } finally {
    clearTimeout(timer);
  }
}
```

### 8.2 `src/content/shared/bridge.ts`

```typescript
const pending = new Map<string, (r: MDFetchBlobResponse) => void>();

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || e.data?.type !== 'MD_RESPONSE') return;
  pending.get(e.data.id)?.(e.data.result);
  pending.delete(e.data.id);
});

export function request(url: string): Promise<MDFetchBlobResponse> {
  const id = crypto.randomUUID();
  return new Promise(resolve => {
    pending.set(id, resolve);
    window.postMessage({ type: 'MD_REQUEST', id, url }, '*');
  });
}
```

### 8.3 `src/content/shared/downloader.ts`

```typescript
export async function downloadBlob(url: string, filename: string): Promise<void> {
  const result = await bridge.request(url);
  if ('error' in result) throw new Error(result.error);
  const blob = new Blob([result.buffer], { type: result.contentType });
  const href = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 100);
}
```

### 8.4 `src/content/shared/ui.ts`

Replaces all three ad-hoc spinner implementations. Single `<style>` injection (idempotent), class-toggle driven.

```typescript
export interface DownloadUI {
  showSpinner(message?: string): void;
  showSuccess(message?: string): void;
  showError(message?: string): void;
  reset(): void;
}

// imagebam: inserts spinner+status span next to the filename element
export function createInlineUI(anchorEl: HTMLElement): DownloadUI

// imgbox, imgbb: overlays spinner state on/over the button itself
export function createButtonUI(buttonEl: HTMLElement): DownloadUI
```

---

## 9. Directory Structure

```
clanker-media-downloader/
├── src/
│   ├── background/
│   │   ├── index.ts              — SW: MD_FETCH_BLOB handler
│   │   └── fetcher.ts            — crossOriginFetchBlob()
│   ├── content/
│   │   ├── redirector.ts         — CDN URL → viewer page redirect (document_start)
│   │   ├── isolated.ts           — config bridge + CSS injection + message relay
│   │   ├── main.ts               — viewer page entry: dispatch to host adapter
│   │   └── shared/
│   │       ├── bridge.ts
│   │       ├── downloader.ts
│   │       └── ui.ts
│   ├── hosts/
│   │   ├── index.ts              — re-exports ALL_MODELS array
│   │   ├── imagebam/
│   │   │   ├── model.ts          — HosterModel definition + default rules
│   │   │   └── adapter.ts        — DOM adapter (button inject, filename, download trigger)
│   │   ├── imgbox/
│   │   │   ├── model.ts
│   │   │   └── adapter.ts
│   │   └── imgbb/
│   │       ├── model.ts
│   │       └── adapter.ts
│   ├── options/                  — full settings UI (options_ui page)
│   │   ├── index.html
│   │   ├── index.ts
│   │   └── styles.css
│   ├── popup/                    — minimal popup (enabled toggle + link to options)
│   │   ├── index.html
│   │   ├── index.ts
│   │   └── styles.css
│   ├── settings/
│   │   ├── schema.ts             — DEFAULT_SETTINGS
│   │   └── resolve.ts            — effectiveRules() merge helper
│   └── types/
│       ├── global.d.ts           — Settings, HosterOverride, etc.
│       ├── hoster.d.ts           — HosterModel, RedirectRule, DownloadConfig
│       └── messages.d.ts         — MD_* message shapes
├── icons/
│   ├── icon-48.png
│   └── icon-96.png
├── vite.config.ts
├── package.json
├── tsconfig.json
└── bunfig.toml
```

---

## 10. Manifest (MV3)

```jsonc
{
  "manifest_version": 3,
  "name": "Clanker Media Downloader",
  "version": "1.0.0",
  "permissions": ["storage"],
  "host_permissions": [
    "https://*.imagebam.com/*",
    "https://imgbox.com/*",
    "https://*.imgbox.com/*",
    "https://ibb.co/*",
    "https://*.ibb.co/*",
    "https://*.imgbb.com/*"
  ],
  "background": { "service_worker": "src/background/index.ts", "type": "module" },
  "action": { "default_popup": "src/popup/index.html" },
  "options_ui": {
    "page": "src/options/index.html",
    "open_in_tab": true
  },
  "content_scripts": [
    // Redirector — CDN domains, document_start
    {
      "matches": ["https://*.imagebam.com/*", "https://*.imgbox.com/*"],
      "js": ["src/content/redirector.ts"],
      "run_at": "document_start",
      "world": "ISOLATED"
    },
    // Viewer pages — ISOLATED bridge + CSS injection
    {
      "matches": [
        "https://www.imagebam.com/image/*",
        "https://www.imagebam.com/view/*",
        "https://imgbox.com/*",
        "https://ibb.co/*"
      ],
      "js": ["src/content/isolated.ts"],
      "run_at": "document_idle",
      "world": "ISOLATED"
    },
    // Viewer pages — MAIN world DOM adapter
    {
      "matches": [
        "https://www.imagebam.com/image/*",
        "https://www.imagebam.com/view/*",
        "https://imgbox.com/*",
        "https://ibb.co/*"
      ],
      "js": ["src/content/main.ts"],
      "run_at": "document_idle",
      "world": "MAIN"
    }
  ]
}
```

---

## 11. Options Page UI Design

### 11.1 Layout

Three-column layout (or two-column on narrow screens). Dark theme, monospace for regex/CSS fields.

```
┌─────────────────────────────────────────────────────────────────────┐
│  ◆ Clanker Media Downloader                              v1.0.0     │
│  ─────────────────────────────────────────────────────────────────  │
│  [● Extension Enabled]                                               │
├──────────────────┬──────────────────────────────────────────────────┤
│                  │                                                    │
│  HOSTERS         │  ImageBam                          [● Enabled]   │
│  ───────         │  ──────────────────────────────────────────────  │
│  ImageBam   ●    │                                                    │
│  ImgBox     ●    │  REDIRECT RULES                   [↺ Reset]      │
│  ImgBB      ○    │  ┌────────────────────────────────────────────┐  │
│                  │  │ ● imagebam-new  New format (uppercase ID)  │  │
│                  │  │   Pattern:  [^https?://(?:thumbs|...      ]│  │
│                  │  │   Template: [https://www.imagebam.com/v..  ]│  │
│                  │  │                                    [✎][✕]  │  │
│                  │  ├────────────────────────────────────────────┤  │
│                  │  │ ● imagebam-old  Old format (lowercase ID)  │  │
│                  │  │   Pattern:  [^https?://(?:images|...      ]│  │
│                  │  │   Template: [https://www.imagebam.com/i..  ]│  │
│                  │  │                                    [✎][✕]  │  │
│                  │  ├────────────────────────────────────────────┤  │
│                  │  │ [+ Add Rule]                               │  │
│                  │  └────────────────────────────────────────────┘  │
│                  │                                                    │
│                  │  CSS OVERRIDES                    [↺ Reset]      │
│                  │  ┌────────────────────────────────────────────┐  │
│                  │  │ /* custom CSS for imagebam viewer */       │  │
│                  │  │ .ads-wrapper { display: none; }            │  │
│                  │  │                                            │  │
│                  │  └────────────────────────────────────────────┘  │
│                  │                                                    │
│                  │  [ Save ]   [ Cancel ]   ✓ Saved                 │
└──────────────────┴──────────────────────────────────────────────────┘
```

### 11.2 Redirect rules component

Each rule row is collapsed by default showing: enable toggle + description + edit + delete buttons. Expanding reveals inline-editable `pattern` and `template` inputs.

**Validation:**
- Pattern field: validate with `new RegExp(value)` on blur — show inline error if invalid (`⚠ Invalid regex`)
- Template field: validate `$1` references against capture group count in pattern — warn if `$1` referenced but no capture group found
- Prevent saving if any rule has invalid pattern

**"Reset to defaults" button:** Clears `redirectRules` override back to `null` in storage → model defaults re-activate on next navigation. Shows a confirmation prompt ("This will discard all your custom rules for ImageBam").

### 11.3 CSS overrides component

Plain `<textarea>` with `font-family: monospace`, resize handle, dark background. No syntax highlighting for V1 — keep it simple.

### 11.4 Popup (minimal)

The popup is intentionally thin — just a quick status indicator and a link to the full settings.

```
┌─────────────────────────────┐
│  ◆ Clanker Media Downloader │
│  ─────────────────────────  │
│  [● Enabled]                │
│                             │
│  Active on this page:       │
│  ImageBam viewer ✓          │
│                             │
│  [⚙ Settings]              │
└─────────────────────────────┘
```

"Active on this page" detects the current tab's hostname against each model's `viewerMatches`, shows which adapter (if any) is active.

---

## 12. Build Setup

Identical toolchain to clanker-clicker-t9000:

```json
{
  "name": "clanker-media-downloader",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build":         "vp build",
    "build:firefox": "BROWSER=firefox vp build",
    "dev":           "vp build --watch",
    "check":         "vp check",
    "lint":          "vp lint src/",
    "fmt":           "vp fmt src/"
  },
  "dependencies": { "webextension-polyfill": "^0.12.0" },
  "devDependencies": {
    "@types/chrome":                "^0.0.268",
    "@types/webextension-polyfill": "^0.12.0",
    "typescript":                   "rc",
    "vite-plugin-web-extension":    "latest",
    "vite-plus":                    "latest"
  }
}
```

**Firefox delta:** `browser_specific_settings.gecko` block (`strict_min_version: "128.0"`). All features used (storage, runtime messaging, content scripts, options_ui) are stable in Firefox MV3.

---

## 13. Implementation Phases

### Phase 1 — Scaffolding
- [ ] `package.json`, `tsconfig.json`, `bunfig.toml`, `vite.config.ts`
- [ ] `icons/` placeholder assets
- [ ] Stub all `src/` files; verify `bun run build` produces valid output

### Phase 2 — Types + settings
- [ ] `types/global.d.ts`, `types/hoster.d.ts`, `types/messages.d.ts`
- [ ] `settings/schema.ts` (DEFAULT_SETTINGS)
- [ ] `settings/resolve.ts` (effectiveRules merge)

### Phase 3 — Hoster models
- [ ] `hosts/imagebam/model.ts` — full default config including regex rules
- [ ] `hosts/imgbox/model.ts`
- [ ] `hosts/imgbb/model.ts`
- [ ] `hosts/index.ts` — ALL_MODELS export

### Phase 4 — Redirect content script
- [ ] `content/redirector.ts` — CDN URL intercept + location.replace
- [ ] Wire into manifest CDN matches
- [ ] Test: open imgbam CDN URL directly → confirms redirect fires

### Phase 5 — Download engine
- [ ] `background/fetcher.ts` + `background/index.ts`
- [ ] `content/shared/bridge.ts`
- [ ] `content/isolated.ts` (bridge relay + CSS injection)
- [ ] `content/shared/downloader.ts`
- [ ] `content/shared/ui.ts`

### Phase 6 — Host adapters (download button injection)
- [ ] `hosts/imagebam/adapter.ts` — UUID filename logic, button hijack
- [ ] `hosts/imgbox/adapter.ts` — path guard, icon→spinner
- [ ] `hosts/imgbb/adapter.ts` — btn-download intercept
- [ ] `content/main.ts` — hostname dispatch

### Phase 7 — Options page
- [ ] `options/styles.css` — dark theme, two-column layout, monospace inputs
- [ ] `options/index.html` — sidebar + main panel skeleton
- [ ] `options/index.ts` — settings load/save, hoster switcher, redirect rules CRUD, CSS textarea
- [ ] Regex validation (inline error on invalid pattern)
- [ ] "Reset to defaults" per-section confirmation

### Phase 8 — Popup
- [ ] `popup/styles.css` + `popup/index.html`
- [ ] `popup/index.ts` — enabled toggle, active-page detection, link to options

### Phase 9 — Polish + verification
- [ ] Load unpacked in Chrome; test redirector on CDN URLs for imagebam + imgbox
- [ ] Test download on all three viewer pages
- [ ] Modify a redirect rule in options; confirm new pattern applies
- [ ] Add a CSS override; confirm it injects on viewer page
- [ ] Firefox build + smoke test
- [ ] `bun run lint && bun run fmt`

---

## 14. Known Gaps / Decisions To Revisit

**ImgBB selector verification.** `a.btn-download` is from a 2023-era userscript. Needs live check before wiring the adapter.

**ImgBox `#img` selector.** Needs live verification. If wrong, fall back to button parent href.

**Redirector timing on slow storage.** If storage read takes >100ms (uncommon but possible on first run), the CDN image may partially render before redirect fires. Not harmful but noticeable. Mitigation: store a synchronous in-memory copy of rules after first load (session cache in ISOLATED world).

**No progress bar.** SW fetch returns a fully-resolved ArrayBuffer — no streaming. For V1, indeterminate spinner. V2: chunked transfer or `ReadableStream` relay over `runtime.sendMessage`.

**Options page responsive layout.** Two-column sidebar layout collapses poorly in the narrow popup context. `options_ui: { open_in_tab: true }` forces it into a full browser tab where width is not an issue.

**ImgBB CDN redirect.** regex.md has no imgbb CDN pattern because imgbb thumbnails on external sites already link to the `ibb.co` viewer URL. No redirect rule needed. If this changes, the model just needs a new `defaultRedirectRules` entry — the infrastructure already supports it.

**Rule ID stability.** User override keying by `rule.id` string means renaming a default rule's `id` orphans the user's stored override (falls back to new default silently). Keep default `id` values stable across extension versions.

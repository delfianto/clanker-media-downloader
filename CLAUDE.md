# Clanker Media Downloader — Agent Reference

MV3 browser extension (Chrome + Firefox) for one-click image downloads from image hosting sites,
with built-in per-hoster thumbnail redirect (CDN URL → viewer page) and user-configurable settings.
Personal tool; no external server dependencies, zero telemetry.

---

## Stack

| Tool                      | Version           | Purpose                                                                                |
| ------------------------- | ----------------- | -------------------------------------------------------------------------------------- |
| TypeScript                | 7.0 RC (`rc` tag) | Language — strict, no legacy cruft                                                     |
| Bun                       | 1.x               | Package manager + script runner (not npm/yarn)                                         |
| vite-plus (`vp`)          | latest            | Unified VoidZero toolchain — bundler, linter (oxlint), formatter (oxfmt), type checker |
| vite-plugin-web-extension | 4.x               | Multi-entry extension build + manifest generation                                      |
| webextension-polyfill     | 0.12              | Unified `browser.*` API surface across Chrome/Firefox                                  |

All commands go through `bun run <script>` or the `vp` CLI directly.  
**Never use npm or npx.**

---

## Build commands

```sh
bun run build           # production build → build/chrome/
bun run build:firefox   # production build → build/firefox/
bun run dev             # watch mode (Chrome)
bun run check           # vp check — fmt + oxlint + tsc (run before committing)
bun run lint            # vp lint src/ — oxlint only
bun run fmt             # vp fmt src/ — oxfmt format
```

Load the extension: Chrome → `chrome://extensions` → Developer mode → Load unpacked → `build/chrome/`

---

## Project structure

```
src/
  background/
    index.ts            # Service worker: MD_FETCH_BLOB handler
    fetcher.ts          # crossOriginFetchBlob() — credentials:omit, cache:force-cache, 30s timeout
  content/
    redirector.ts       # ISOLATED, document_start — CDN URL → viewer page (reads storage, location.replace)
    isolated.ts         # ISOLATED, document_idle — CSS injection + postMessage bridge relay
    main.ts             # MAIN, document_idle — hostname dispatch → host adapter
    shared/
      bridge.ts         # MAIN-world postMessage bridge (MD_REQUEST/MD_RESPONSE, pending Map)
      downloader.ts     # downloadBlob() — request via bridge, Blob → object URL → anchor click
      ui.ts             # DownloadUI interface — createInlineUI() / createButtonUI()
  hosts/
    index.ts            # ALL_MODELS array export
    imagebam/
      model.ts          # HosterModel definition — viewerMatches, cdnMatches, defaultRedirectRules, downloadConfig
      adapter.ts        # DOM adapter — button injection, UUID filename logic, download trigger
    imgbox/
      model.ts
      adapter.ts        # path guard: /^\/[a-zA-Z0-9]{8}$/ before activating
    imgbb/
      model.ts
      adapter.ts
  options/              # Full settings page (open_in_tab: true)
    index.html / index.ts / styles.css
  popup/                # Minimal popup — enabled toggle + active-page indicator + link to options
    index.html / index.ts / styles.css
  settings/
    schema.ts           # DEFAULT_SETTINGS — single source of defaults (no DOM imports)
    resolve.ts          # effectiveRules(model, override) — merges defaults with stored overrides
  types/
    global.d.ts         # Settings, HosterOverride, HosterId
    hoster.d.ts         # HosterModel, RedirectRule, DownloadConfig, FilenameStrategy
    messages.d.ts       # MDFetchBlobRequest/Response, MDMainRequest/Response
```

---

## World split architecture — CRITICAL

MV3 extensions have two content script worlds with a hard security boundary:

**ISOLATED world** — has `browser.*` API, cannot touch page JS globals  
**MAIN world** — runs in page's JS context, no `browser.*` API

### ISOLATED → MAIN config delivery (`isolated.ts` → `main.ts`)

Same CustomEvent bridge as sister project clanker-clicker-t9000:

```
isolated.ts                               main.ts
───────────                               ───────
await storage.local.get()                document.addEventListener('__md_config__', handler, { once: true })
                                          ↑ registered synchronously at module load
↓ (async gap — listener ready by now)
document.dispatchEvent(
  new CustomEvent('__md_config__', { detail: JSON.stringify(config) })
)
                                          → handler fires → run(config)
```

**Do NOT use `<script>` tag injection** — breaks on CSP-strict sites.

### MAIN → ISOLATED relay (for SW fetch from MAIN world)

MAIN world posts `{ type: 'MD_REQUEST', id, url }` via `window.postMessage`.  
`isolated.ts` receives it, calls `browser.runtime.sendMessage({ type: 'MD_FETCH_BLOB', url })` to SW.  
SW returns `{ buffer: ArrayBuffer, contentType: string }`.  
`isolated.ts` posts `{ type: 'MD_RESPONSE', id, result }` back with buffer as a transferable.

**Transferable:** always pass `ArrayBuffer` as the third argument to `postMessage` (`[result.buffer]`) — zero-copy, avoids memory doubling on large images.

---

## Hoster model system

Each site (`imagebam`, `imgbox`, `imgbb`) is defined as a `HosterModel` in `src/hosts/{id}/model.ts`.
The model is the **single source of truth for defaults** — redirect rules, download selectors, filename strategy.

Settings storage holds only user *overrides*:
- `redirectRules: null` → use model defaults (no stored rules)
- `redirectRules: RedirectRule[]` → fully replaces defaults for this hoster
- `cssOverrides: ''` → none applied

`settings/resolve.ts` — `effectiveRules(model, override)` merges at runtime.

### Adding a new hoster

1. Create `src/hosts/{id}/model.ts` with `HosterModel` definition
2. Create `src/hosts/{id}/adapter.ts` with DOM button injection + download trigger
3. Add to `src/hosts/index.ts` ALL_MODELS export
4. Add viewer page matches + CDN matches to `vite.config.ts` manifest builder
5. Run `bun run check` — fix type errors before committing

---

## Redirect mechanism

`content/redirector.ts` runs at `document_start` in ISOLATED world on CDN domains
(`*.imagebam.com`, `*.imgbox.com`). It loads effective rules from storage and tests
`location.href` against each. On match: `location.replace(resolvedTemplate)`.

Template substitution: `$1`/`$2` → capture groups from the rule regex.

**User overrides take effect on the next CDN URL navigation** — no reload of viewer pages needed.

---

## TypeScript conventions

- TS 7 RC: `baseUrl` is **removed** — don't add it to `tsconfig.json`
- `exactOptionalPropertyTypes: true` — no implicit `undefined` spreading
- `noUncheckedIndexedAccess: true` — array index returns `T | undefined`
- `verbatimModuleSyntax: true` — use `import type` for type-only imports
- `skipLibCheck: true` — upstream Rollup/Vite type mismatch; do not remove
- Ambient `.d.ts` files cannot have initializers — types only, no `= value`

---

## oxlint / oxfmt rules

Config lives inside `vite.config.ts` under `lint:` and `fmt:` blocks.  
Standalone `oxlint.json` is **not picked up** by `vp` — don't create one.

Active rules:
- `no-console: off` — console usage allowed
- `unicorn/no-thenable: error` — no property named `then` on plain objects

---

## Icons

`icons/icon-48.png` and `icon-96.png` — same Microsoft Fluent Emoji 3D robot set as sister project (MIT).  
Resized with `magick input.png -resize NxN -filter Lanczos output.png`.

---

## Git hygiene

- `build/` — gitignored; always regenerated
- `*.xpi` — gitignored
- `.claude/settings.local.json` — gitignored; local permission overrides stay local

### Post-commit build hook

A `PostToolUse` hook on `Bash(git commit*)` runs `bun run build` automatically after every commit.
**Always run `git add` and `git commit` as separate Bash calls** — combining them with `&&` makes the
hook matcher miss the commit (the compound starts with `git add`, not `git commit`).

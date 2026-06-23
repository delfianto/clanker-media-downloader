# clanker-media-downloader

> A one-click image downloader for image hosting sites, built as a MV3 browser extension.  
> Engineered with the structural integrity of a nuclear bunker to save JPEGs.  
> And MP4s. And MOVs. Entire galleries of them. At once.

---

## What Is This

A browser extension. It puts a download button on images. That's it. That's the whole pitch.

You visit a page on [ImageBam](https://imagebam.com), [ImgBox](https://imgbox.com), [ImgBB](https://imgbb.com), or [Bunkr](https://bunkr.si), and instead of right-click-saving-as like some kind of prehistoric cave-dweller, you get a button. You press the button. The image downloads. Revolutionary.

Oh, you want to download an entire gallery? 154 files? One click. The extension queues them, resolves each viewer page, signs CDN URLs, retries transient failures with exponential backoff, tracks actual completion via Chrome's download manager (not just "we clicked the button, good luck"), splits parallelism by media type so images fly through 5 at a time while 2GB videos trickle one at a time so the CDN doesn't have a stroke, sanitizes filenames for Windows, detects mojibake garbage filenames and replaces them with file IDs, and logs every step of it to a Logs tab you can copy to clipboard and paste into an issue that will never be read.

Behind this trivial act of clicking a button lies:

- A **Manifest V3 service worker** that proxies cross-origin fetch requests because Chrome in its infinite wisdom decided content scripts shouldn't be able to just download things normally
- A **dual content-script world architecture** with an elaborate `postMessage` bridge relay system because MV3 extension worlds cannot talk to each other like adults
- **TypeScript 7 RC** — yes, the release candidate, because apparently downloading JPEGs required the absolute bleeding edge of Microsoft's type system
- A full **hoster model abstraction layer** with redirect rules, CDN URL rewriting, per-site override schemas, per-hoster gallery adapters, and SW-side hooks for URL signing and viewer-page extraction — for four websites
- `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`, `verbatimModuleSyntax: true` — a tsconfig so strict it would reject your grandmother's birthday card for insufficient type narrowing
- A settings page. An **options page**. With CSS. With per-hoster toggles. For a download button.
- **83 unit tests** covering filename sanitization, mojibake detection (with real Unicode codepoints from a live imagebam gallery), media-type classification, and transient error retry logic. Because of course there are.
- **Download completion tracking** via `browser.downloads.onChanged` — because `browser.downloads.download()` resolves on *initiation*, not completion, and the previous version was silently dropping files the CDN rejected while counting them as "ok." That was a fun bug to find.

Is this over-engineered? Yes. Does that bother the author? No. Were several serious architectural decisions made at 2am about the correct way to transfer `ArrayBuffer` as a transferable across a postMessage boundary to avoid memory doubling? Also yes. Was a refactor done to extract all hoster-specific gallery logic out of shared code into per-hoster adapters because the shared runner had three `model.id ===` branches copy-pasting the same progress listener? Also also yes.

---

## Supported Sites

| Site | What it does |
|------|-------------|
| ImageBam | Single download button, CDN → viewer redirect, gallery batch download with UUID/mojibake filename fallback |
| ImgBox | Same but with an 8-character path guard regex, thumbnail→full-res URL transform |
| ImgBB | Same but slightly different DOM, anchor-href gallery strategy |
| Bunkr | The whole beast: 21 mirror domains, `window.albumFiles` collection, viewer-page HTML extraction, CDN URL signing via `glb-apisign.cdn.cr`, "Server under maintenance" detection, `<source>`/`<video>` fallback for video pages, per-hoster CSS injection |

If your favorite image hosting site isn't here: that's your problem, not mine.

---

## HOW TO USE IT

> **READ THIS SECTION. THIS IS THE ENTIRE USER GUIDE. THERE IS NO OTHER USER GUIDE.**

### You Will NOT Find This On:

- ❌ The Chrome Web Store
- ❌ Firefox Add-ons (addons.mozilla.org)
- ❌ The Opera add-ons store (lmao)
- ❌ Any browser extension marketplace anywhere on earth
- ❌ A published release with a nice changelog and semantic versioning

**The author has absolutely no intention, desire, plan, roadmap item, backlog ticket, or fever dream of ever submitting this to any extension marketplace.** None. Zero. The Chrome Web Store review process can eat a bag of rocks.

### You WILL:

Clone the repo and load it yourself like a person who knows what a terminal is.

```sh
git clone <this repo>
cd clanker-media-downloader
bun install
bun run build
```

Then go to `chrome://extensions`, enable Developer Mode, click "Load unpacked", point it at `build/chrome/`.

Firefox:
```sh
bun run build:firefox
```
Load `build/firefox/` via `about:debugging`.

That's it. You're done. You now have a download button on images. Congratulations.

### Gallery Downloads

On any supported gallery/album page, you'll see a download button injected into the page UI. Click it. The extension:

1. Collects all items (from DOM, or from `window.albumFiles` on Bunkr)
2. Fetches additional paginated pages if they exist
3. De-duplicates items
4. Sends the batch to the service worker
5. The SW resolves each item (fetch viewer page → extract CDN URL → sign if needed)
6. Downloads run in two parallel queues — images at `maxParallelImg` (default 5), videos at `maxParallelVid` (default 1) — because CDNs throttle large parallel transfers and you end up with `SERVER_CONTENT_LENGTH_MISMATCH` errors on 2GB files
7. Retries transient failures (`SERVER_FAILED`, `NETWORK_FAILED`, `CRASH`, `SERVER_CONTENT_LENGTH_MISMATCH`) up to 3 times with 1s/2s/4s exponential backoff
8. Retries HTTP 502/503/504 on viewer page fetches and sign API calls
9. Tracks actual completion via `browser.downloads.onChanged` — not just "we asked Chrome to download it"
10. Sanitizes filenames for Windows (`\ / : * ? " < > |` and control chars → `_`)
11. Logs everything to the Logs tab

You can watch progress in the Downloads tab (History sub-tab), copy logs to clipboard for bug reports that will never be filed, and adjust parallelism settings in the Settings sub-tab.

### ImageBam Filename Fallback

ImageBam sometimes assigns UUIDs or absolute mojibake garbage (broken Unicode from encoding mismatches like `54­Øÿ╝­ØÖº­ØÖÜ­ØÖû 69.jpg`) as filenames. The "Use Fallback Name" toggle (on by default) detects these and replaces them with the ImageBam file ID from the URL, preserving the extension. So `54­Øÿ╝­ØÖÚ­ØÖÜ­ØÖû 69.jpg` becomes `ME2PNA7.jpg`. Normal filenames — ASCII, CJK, Japanese, Korean — pass through untouched.

### A Note On "Manual" Downloads

On supported sites, the extension doesn't add a *separate* download button — it **hijacks the site's existing download button**. `event.preventDefault()` eats the native click, and the download is routed through the extension's service worker with your configured download directory (`Clanker/` by default).

This means: on ImageBam, ImgBox, ImgBB, and Bunkr, **every** click on the site's own download button goes through the extension. There is no "manual" download on these sites anymore. If you disable a hoster in the options page, the native button is left alone and works normally. If the extension is enabled for that hoster, the button is ours.

This is not a bug. This is the entire point. The extension exists because the native download buttons on these sites are terrible — they pop up ads, redirect through intermediary pages, or require multiple clicks. The extension replaces that with one click and a clean filename. The tradeoff is that your downloads go to `Clanker/` instead of your browser's default location. You can change the directory in Settings, or disable a hoster entirely if you want the native experience back.

---

## Support

There is no support.

If you open an issue, it will be read. Whether anything happens after that is entirely a function of the author's mood, the phase of the moon, and how many other things are currently on fire. Probably nothing happens. Probably you sit there. Probably the issue eventually gets stale-bot'd into the void.

Do not open a support ticket. There is no support ticket system. This README is the support system. You are reading the support system right now.

---

## Warranty

There is no warranty.

This software is provided "as is," which is a legal way of saying "it works on the author's machine and that's the only machine the author cared about." If it breaks your browser, corrupts your downloads folder, causes your cat to look at you judgmentally, or somehow triggers a cross-origin security audit at your workplace — that's between you and your life choices.

---

## A Note On Code Quality

This extension was written with significant assistance from a Large Language Model. The author has been asked to feel shame about this. The author does not feel shame about this.

Call it slop code. Call it AI-generated garbage. Call it gruel code, vibe code, prompt-to-shipped, ChatGPT spaghetti, LLM drool, whatever the currently fashionable pejorative is this week on Hacker News. The extension works. The images download. The TypeScript compiles clean with zero errors. The linter is satisfied. The architecture is, somewhat irritatingly, better than most hand-written browser extensions found in the wild.

If your feelings about LLM-assisted code are stronger than your desire to have a working download button: great, good for you, the Chrome Web Store has twelve other extensions for this, go use those, godspeed.

---

## Architecture (For The Curious / Masochistic)

The following is a real description of what happens when you press the download button:

### Single-image download

```
CDN URL hits redirector.ts (ISOLATED world, document_start)
  → location.replace() to viewer page

Viewer page loads isolated.ts (ISOLATED world, document_idle)
  → reads settings from browser.storage.local
  → dispatches __md_config__ CustomEvent to MAIN world
  → listens for window.postMessage relay requests

main.ts (MAIN world, document_idle)
  → receives config via __md_config__ listener
  → dispatches to host adapter (imagebam/imgbox/imgbb/bunkr)
  → adapter injects button into DOM
  → on click: posts MD_REQUEST via postMessage bridge

bridge.ts (MAIN world)
  → pending Map<id, resolve/reject>
  → posts to window, isolated.ts picks it up

isolated.ts (relay)
  → receives MD_REQUEST
  → browser.runtime.sendMessage MD_FETCH_BLOB to SW

background/index.ts (Service Worker)
  → fetch() with credentials:omit, 30s timeout
  → sanitizeFilename() before browser.downloads.download()
  → returns ArrayBuffer + contentType

isolated.ts
  → posts MD_RESPONSE back with buffer as transferable [zero-copy]

downloader.ts (MAIN world)
  → Blob from ArrayBuffer → objectURL → <a> click
  → file saved to disk
```

### Gallery batch download

```
Gallery page loads → isolated.ts → __md_config__ → main.ts
  → runGalleryAdapter(model, config, adapter.activateGallery)
  → collects items (DOM strategy or model.collectAllItems)
  → fetches pagination pages if present, de-duplicates
  → adapter.injectGalleryButton — hoster-specific HTML, CSS, placement
  → user clicks → triggerDownload()
  → posts MD_GALLERY_START to ISOLATED → SW

background/gallery.ts (Service Worker)
  → partitions items: isMediaFile() → image queue + media queue
  → runQueue(job, imageEntries, maxParallelImg)
  → runQueue(job, mediaEntries, maxParallelVid)
  → both run concurrently via Promise.all
  → per item: fetchWithRetry(viewer page) → model.extractFromViewer()
    → model.resolveUrl() (bunkr signing) → sanitizeFilename()
    → browser.downloads.download() → onChanged listener confirms completion
  → transient errors retried 3x with 1s/2s/4s backoff
  → progress broadcast to options page + all tabs
```

All of this happens so you can press a button and get a JPEG. Every single layer of this is load-bearing because MV3 is what happens when a browser vendor redesigns their extension API while clearly never having talked to an extension developer. The author did not choose this architecture for fun. The author chose this architecture because every simpler path was bricked.

---

## Tech Stack

| Thing | Why |
|-------|-----|
| TypeScript 7 RC | Felt dangerous. Lived. |
| Bun | npm is slow and boring. Also its built-in test runner is zero-config. |
| vite-plus (`vp`) | Unified VoidZero toolchain — lint, fmt, typecheck, build |
| vite-plugin-web-extension | Extension builds without wanting to die |
| webextension-polyfill | `browser.*` everywhere, `chrome.*` nowhere |
| `bun test` | 83 tests, 0 dependencies, 9 milliseconds. Eat that, Jest. |

---

## Adding More Sites

See `AGENTS.md` for the full hoster model documentation. The short version:

1. Write a `HosterModel` in `src/hosts/{id}/model.ts` — redirect rules, download config, gallery config, optional `extractFromViewer`/`resolveUrl` hooks for SW-side peculiarities
2. Write a DOM adapter in `src/hosts/{id}/adapter.ts` — `activate()` for single-download, `activateGallery()` for gallery button injection (own HTML, CSS, placement)
3. Add it to `src/hosts/index.ts`
4. Wire up the manifest entries in `vite.config.ts`
5. `bun run check && bun test && bun run build`

The shared gallery runner has zero `model.id ===` checks. The SW has zero hoster-specific logic. All peculiarities live in the model and adapter. This is the way it should be. It was not always this way, and the git log bears the scars.

The author may or may not ever do this. No commitments are being made here.

---

## License

MIT. Take it. Fork it. Reskin it. Sell it on the Chrome Web Store under a different name and make millions (you won't). The author cannot stop you and, frankly, lacks the energy to try.

---

*Personal tool. No commercial intent. No support. No warranty. Yes, an LLM wrote a substantial portion of this. No, the author does not care what you think about that. 83 tests pass. The images download. The videos download. The mojibake gets replaced. The CDN gets retried. Everything is fine.*

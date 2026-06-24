# Architecture (For The Curious / Masochistic)

The following is a real description of what happens when you press the download button.

This is not a joke. This is actually how the extension has to work because Manifest V3 is what happens when a browser vendor redesigns their extension API while clearly never having talked to an extension developer. Every single layer of this is load-bearing. The author did not choose this architecture for fun. The author chose this architecture because every simpler path was bricked.

---

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

All of this happens so you can press a button and get a JPEG. Just let that sink in.

---

## Hacks & MV3 Absurdities

Because we are forced to use the `browser.downloads` API, we are entirely at the mercy of Chrome's native download manager, which is apparently held together by duct tape and prayers. Here are the specific absurdities we actively mitigate:

### The Download Bubble Freeze (Or: Why Your Browser Becomes Slower Than a Sloth)
If we didn't hijack the native download buttons on these sites, clicking a "download all" button on a native gallery page would instantly trigger 150 separate `<a download>` clicks simultaneously. 

Chrome handles this by trying to spawn a new "Download UI" bubble/tray instance for every single file. The browser's main UI thread completely locks up attempting to render 150 download animations at once, and your browser becomes slower than a sloth and completely unresponsive.

**The Hack:** The extension aggressively hijacks the native download buttons via `event.preventDefault()`. We route everything through our Service Worker queue and strictly enforce a concurrency limit (default 5 for images). This trickles the downloads to Chrome's native manager at a survivable pace, preventing the UI thread from having a heart attack.

### The `mkdir` Race Condition (Or: Why Your Files End Up in the Root Folder)
Even with controlled concurrency, if you fire off 5 concurrent downloads into a brand new, non-existent subfolder (e.g. `Clanker/MyNewGallery`), Chromium on Linux encounters a catastrophic VFS (Virtual File System) bug. 

Multiple threads attempt to `mkdir` the directory simultaneously. They collide. The disk I/O blocks heavily, your entire browser stutters like it's rendering a 4k video on a toaster, and the download manager completely loses its mind. 

Its "solution" to this race condition? It maliciously strips your custom subfolder path and dumps all 154 gallery images directly into your root `~/Downloads` folder. 

**The Hack:** Before starting any gallery queue, the extension synchronously downloads a dummy text file (`.md-keep`) into the target subfolder, waits for the native file write to finish so the directory is *guaranteed* to exist, and then silently deletes the dummy file. Chromium sees the directory exists, skips the buggy `mkdir` race entirely, and your browser survives.

### The Randomly Killed Download Process (OOM Starvation)
In MV3, Service Workers are ephemeral. They die. Often. If you use `browser.runtime.onMessage` and return a Promise without properly resolving it, or if you hold open too many `MessagePorts` simultaneously during a massive batch download, Chrome decides your Service Worker has a memory leak.

Chrome's response? It forcefully terminates the worker in the middle of your download queue. 

**The Hack:** We use a `Port` keep-alive ping system that prevents the worker from sleeping while the queue is active. Furthermore, we absolutely never `return` directly from the `onMessage` handler to avoid port leakage. We handle the async work separately and use `sendResponse` explicitly. 

### "Random" Files in `~/Downloads`
Sometimes a CDN rate-limits you and returns an HTTP 200 OK... but the payload is a Cloudflare block HTML page. 

Chrome's download manager sniffs the HTML body, aggressively renames the file from `.jpg` to `.html`, maliciously strips our custom subfolder path (again), and dumps it into the root `~/Downloads` directory. And then sometimes marks the download as a `SERVER_FAILED` error anyway, just to mock you.

**The Hack:** The Service Worker performs an explicit `HEAD` (or `GET`) request before passing the URL to the download manager. If the `Content-Type` is `text/html`, we throw an error and abort the download *before* Chrome can touch it, preventing HTML litter in your downloads folder.

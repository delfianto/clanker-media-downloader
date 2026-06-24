# Supported Hosters

This extension supports downloading from the following hosters. If your favorite image hosting site isn't here: that's your problem, not mine.

The architecture isolates all hoster-specific quirks into their own respective configuration models and DOM adapters. The service worker doesn't know what an "imagebam" is, it just asks the model to extract URLs.

## Hoster Quirks & Documentation

Because the web is a terrible place built on hacks and dreams, every image hoster operates entirely differently. Some are normal. Some sign their CDN URLs with cryptographic hashes. Some serve 200 OK HTML pages instead of JPEGs when you get rate limited. Some use infinite-scroll React SPAs that hide pagination links from the DOM entirely.

Each hoster's unique brand of nonsense is documented below:

- [ImageBam](HOSTER_IMAGEBAM.md)
- [ImgBox](HOSTER_IMGBOX.md)
- [ImgBB](HOSTER_IMGBB.md)
- [Bunkr](HOSTER_BUNKR.md)
- [Erome](HOSTER_EROME.md)
- [JPG6](HOSTER_JPG6.md)
- [GirlsReleased](HOSTER_GIRLSRELEASED.md)

---

## The Gallery Pipeline

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

---

## Adding More Sites

Do you want to subject yourself to this architecture? Fine. Here is how you do it.

1. **Write a `HosterModel`** in `src/hosts/{id}/model.ts`. 
   Define the redirect rules, download config, gallery config, and any optional `extractFromViewer`/`resolveUrl` hooks for Service Worker-side peculiarities.
2. **Write a DOM adapter** in `src/hosts/{id}/adapter.ts`.
   Implement `activate()` for single-download injection and `activateGallery()` for gallery button injection (you get to write your own HTML, CSS, and placement logic).
3. **Add it** to `src/hosts/index.ts`.
4. **Wire up** the manifest entries in `vite.config.ts` so the extension actually runs on the domains.
5. **Run the gauntlet**: `bun run check && bun test && bun run build`

The shared gallery runner has **zero** `model.id === "my_hoster"` checks. The SW has **zero** hoster-specific logic. All peculiarities live in the model and adapter. This is the way it should be. It was not always this way, and the git log bears the scars.

The author may or may not ever accept a PR adding a new site. No commitments are being made here.

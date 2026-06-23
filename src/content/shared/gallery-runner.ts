import type { MDConfig } from "../../types/global";
import type { GalleryConfig, HosterModel } from "../../types/hoster";
import type { GalleryJobItem, MDGalleryStartRequest } from "../../types/messages";
import type { GalleryCtx } from "./gallery-ui";

import { sanitizeFilename } from "../../background/sanitize";

function buildSubfolder(albumName: string, config: MDConfig): string {
  if (!config.autoFolderPerAlbum) return config.downloadDirectory;
  const safeName = albumName
    .split("/")
    .map((seg) => sanitizeFilename(seg))
    .join("/");
  return config.downloadDirectory ? `${config.downloadDirectory}/${safeName}` : safeName;
}

// ── URL helpers ──────────────────────────────────────────────────────────────

function basenameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    return path.split("/").at(-1) ?? "file";
  } catch {
    return "file";
  }
}

// ── Strategy: thumbnail-transform ───────────────────────────────────────────

function collectThumbnailTransform(
  gc: GalleryConfig,
  doc: Document | Element = document,
): GalleryJobItem[] {
  const src = gc.imageSource;
  if (src.strategy !== "thumbnail-transform") return [];
  const imgs = Array.from(doc.querySelectorAll<HTMLImageElement>(src.selector));
  return imgs
    .map((img) => img.src)
    .filter(Boolean)
    .map((thumbSrc) => {
      const imageUrl = src.buildUrl(thumbSrc);
      return { kind: "resolved" as const, imageUrl, filename: basenameFromUrl(imageUrl) };
    });
}

// ── Strategy: anchor-href ────────────────────────────────────────────────────

function collectAnchorHref(
  gc: GalleryConfig,
  doc: Document | Element = document,
): GalleryJobItem[] {
  const src = gc.imageSource;
  if (src.strategy !== "anchor-href") return [];
  const imgs = Array.from(doc.querySelectorAll<HTMLImageElement>(src.imageSelector));
  return imgs
    .map((img) => img.src)
    .filter(Boolean)
    .map((imageUrl) => ({
      kind: "resolved" as const,
      imageUrl,
      filename: basenameFromUrl(imageUrl),
    }));
}

// ── Strategy: resolve-viewer ─────────────────────────────────────────────────

function collectResolveViewer(
  gc: GalleryConfig,
  doc: Document | Element = document,
  useFallbackName = false,
): GalleryJobItem[] {
  const src = gc.imageSource;
  if (src.strategy !== "resolve-viewer") return [];
  const anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>(src.anchorSelector));
  return anchors
    .filter((a) => !!a.href)
    .map((a) => {
      const viewerUrl = a.href;
      const fileId = viewerUrl.split("/").at(-1) ?? "file";
      let filename = fileId;
      if (src.filenameSelector) {
        const nameEl = a.querySelector(src.filenameSelector);
        if (nameEl?.textContent) {
          filename = nameEl.textContent.trim();
        }
      }
      // If the user enabled "Use Fallback Name" and the model says the name
      // is bizarre (UUID, mojibake, etc.), use the file ID from the URL.
      if (useFallbackName && gc.isBizarreName?.(filename)) {
        const dot = filename.lastIndexOf(".");
        const ext = dot >= 0 ? filename.slice(dot + 1) : "";
        filename = ext ? `${fileId}.${ext}` : fileId;
      }
      return {
        kind: "resolve-viewer" as const,
        viewerUrl,
        extractor: src.extractor,
        filename,
      };
    });
}

// ── Pagination helpers ────────────────────────────────────────────────────────

function collectPageUrls(): string[] {
  const pagination = document.querySelector(
    ".pagination, .pages, [class*='pagination'], .paginator",
  );
  if (!pagination) return [];
  const links = Array.from(pagination.querySelectorAll<HTMLAnchorElement>("a[href]"));
  const currentPath = window.location.pathname;
  const urls = links
    .map((a) => {
      try {
        return new URL(a.href, window.location.href);
      } catch {
        return null;
      }
    })
    .filter(
      (u): u is URL =>
        u !== null && u.origin === window.location.origin && u.pathname === currentPath,
    )
    .map((u) => u.href);
  return Array.from(new Set(urls)).filter((href) => href !== window.location.href);
}

async function fetchAdditionalItems(
  pageUrls: string[],
  gc: GalleryConfig,
  useFallbackName = false,
): Promise<GalleryJobItem[]> {
  const allItems: GalleryJobItem[] = [];
  const parser = new DOMParser();

  // Fetch all pages in parallel
  const htmlTexts = await Promise.all(
    pageUrls.map((url) =>
      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.text();
        })
        .catch((err) => {
          console.error(`[md] failed to fetch page ${url}:`, err);
          return "";
        }),
    ),
  );

  for (const html of htmlTexts) {
    if (!html) continue;
    try {
      const doc = parser.parseFromString(html, "text/html");
      let pageItems: GalleryJobItem[] = [];
      if (gc.collectAllItems) {
        pageItems = gc.collectAllItems(doc);
      } else {
        switch (gc.imageSource.strategy) {
          case "thumbnail-transform":
            pageItems = collectThumbnailTransform(gc, doc);
            break;
          case "anchor-href":
            pageItems = collectAnchorHref(gc, doc);
            break;
          case "resolve-viewer":
            pageItems = collectResolveViewer(gc, doc, useFallbackName);
            break;
        }
      }
      allItems.push(...pageItems);
    } catch (e) {
      console.error("[md] failed to parse page document:", e);
    }
  }

  return allItems;
}

// ── Main entry ───────────────────────────────────────────────────────────────

// Each hoster's adapter exports an activateGallery function that owns its
// button HTML, placement, and progress wiring. The shared runner collects
// items, handles pagination, and dispatches to the adapter.
export type GalleryAdapterFn = (model: HosterModel, ctx: GalleryCtx) => void;

let activeInterval: any = null;

export function runGalleryAdapter(
  model: HosterModel,
  config: MDConfig,
  activateGallery: GalleryAdapterFn,
): void {
  const gc = model.galleryConfig;
  if (!gc) return;

  console.log(
    "[md] runGalleryAdapter initializing for model:",
    model.id,
    "waitForSelector:",
    gc.waitForSelector,
  );

  if (activeInterval) {
    clearInterval(activeInterval);
    activeInterval = null;
  }

  // Remove any previously injected gallery buttons to avoid duplicates on SPA transitions
  document.querySelectorAll("[class*='gallery-btn']").forEach((el) => el.remove());
  document.querySelectorAll(".md-gallery-btn-wrap").forEach((el) => el.remove());

  function run() {
    console.log("[md] runGalleryAdapter: run() triggered");
    const albumIdMatch = new RegExp(gc!.albumIdFromPath).exec(location.pathname);
    const albumId = albumIdMatch?.[1] ?? location.pathname.split("/").at(-1) ?? "album";

    const albumName = model.getGalleryName
      ? (model.getGalleryName(document) ?? albumId)
      : (document.querySelector(gc!.albumNameSelector)?.textContent?.trim() ?? albumId);

    // Prefer the model's custom collector (e.g. Bunkr reads window.albumFiles for
    // the full list regardless of pagination/view mode). Fall back to strategy-
    // based DOM scraping for other hosters.
    const useFallback = config.useFallbackName ?? false;
    let items: GalleryJobItem[];
    if (gc!.collectAllItems) {
      items = gc!.collectAllItems();
    } else {
      switch (gc!.imageSource.strategy) {
        case "thumbnail-transform":
          items = collectThumbnailTransform(gc!);
          break;
        case "anchor-href":
          items = collectAnchorHref(gc!);
          break;
        case "resolve-viewer":
          items = collectResolveViewer(gc!, document, useFallback);
          break;
      }
    }

    console.log("[md] runGalleryAdapter: items collected length =", items.length);
    if (items.length === 0) return;

    const subfolder = buildSubfolder(albumName, config);

    // Shared triggerDownload — handles pagination + de-duplication, then posts
    // the MDGalleryStartRequest to the ISOLATED world relay. Each adapter's
    // button click handler calls this.
    async function triggerDownload(
      btnElement: HTMLElement,
      loadingIcon: string,
      _doneIcon: string,
    ): Promise<string> {
      btnElement.classList.add("loading");

      const otherPageUrls = collectPageUrls();
      let jobItems = items.slice();
      if (otherPageUrls.length > 0) {
        btnElement.innerHTML = loadingIcon;
        const extra = await fetchAdditionalItems(otherPageUrls, gc!, useFallback);
        jobItems.push(...extra);

        // De-duplicate
        const seen = new Set<string>();
        jobItems = jobItems.filter((item) => {
          const key = item.kind === "resolve-viewer" ? item.viewerUrl : item.imageUrl;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }

      // If we are crawling a listing/site page (represented by items with /set/ viewer URLs),
      // fetch each set page's API data in parallel and extract its real items.
      const hasSets = jobItems.some(
        (item) => item.kind === "resolve-viewer" && item.viewerUrl.includes("/set/"),
      );
      if (hasSets) {
        btnElement.innerHTML = loadingIcon;
        const expandedItems: GalleryJobItem[] = [];

        // Fetch all set pages' API data in parallel
        await Promise.all(
          jobItems.map(async (item) => {
            if (item.kind === "resolve-viewer" && item.viewerUrl.includes("/set/")) {
              try {
                const setIdMatch = /\/set\/(\d+)/.exec(item.viewerUrl);
                const setId = setIdMatch?.[1];
                if (!setId) return;

                const res = await fetch(`/api/0.3/set/${setId}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();

                const setArray = data?.set;
                if (!Array.isArray(setArray)) return;

                const setName = setArray[1] || "";
                const siteName = setArray[3] || "";
                const filesArray = setArray[4] || [];
                const models = setArray[5];
                const modelName = Array.isArray(models) && models[0] ? models[0][1] : "";

                let cleanSite = siteName.replace(/\.[a-z]{2,6}$/i, "");
                cleanSite = cleanSite.charAt(0).toUpperCase() + cleanSite.slice(1);

                const cleanSetName = setName.replace(/\s*\/\s*/g, " - ");
                const detectedSetName = modelName
                  ? `${cleanSite}/${modelName} - ${cleanSetName}`
                  : `${cleanSite}/${cleanSetName}`;

                const setSubfolder = detectedSetName ? buildSubfolder(detectedSetName, config) : "";

                for (const file of filesArray) {
                  if (!Array.isArray(file) || file.length < 6) continue;
                  const viewerUrl = file[3] as string;
                  const thumbnailUrl = (file[4] as string) || "";
                  const originalFilename = (file[5] as string) || "";
                  if (!viewerUrl && !thumbnailUrl) continue;

                  const filename = originalFilename || viewerUrl?.split("/").at(-1) || "file";

                  // If we have an imx.to thumbnail, derive the full-res URL directly
                  // by replacing /u/t/ (thumbnail) with /u/i/ (full image).
                  // This skips both the GET and POST to imx.to entirely.
                  if (thumbnailUrl.includes("/u/t/")) {
                    expandedItems.push({
                      kind: "resolved",
                      imageUrl: thumbnailUrl.replace("/u/t/", "/u/i/"),
                      filename,
                      subfolder: setSubfolder,
                    });
                  } else {
                    expandedItems.push({
                      kind: "resolve-viewer",
                      viewerUrl,
                      extractor: "continuebutton",
                      filename,
                      subfolder: setSubfolder,
                    });
                  }
                }
              } catch (err) {
                console.error(`[md] failed to crawl set ${item.viewerUrl}:`, err);
              }
            } else {
              expandedItems.push(item);
            }
          }),
        );
        jobItems = expandedItems;
        console.log(
          `[md] set expansion complete: ${expandedItems.length} items from ${jobItems.length > 0 ? "sets" : "0 sets"}`,
        );
      }

      btnElement.innerHTML = loadingIcon;

      const jobId = crypto.randomUUID();
      const req: MDGalleryStartRequest = {
        type: "MD_GALLERY_START",
        jobId,
        hosterId: model.id,
        subfolder,
        items: jobItems,
        maxParallelImg: config.maxParallelImg,
        maxParallelVid: config.maxParallelVid,
      };
      window.postMessage(req, "*");
      return jobId;
    }

    const ctx: GalleryCtx = { items, subfolder, albumName, triggerDownload };
    activateGallery(model, ctx);
  }

  if (gc.waitForSelector && !document.querySelector(gc.waitForSelector)) {
    const selector = gc.waitForSelector;
    let elapsed = 0;
    activeInterval = setInterval(() => {
      if (document.querySelector(selector)) {
        clearInterval(activeInterval);
        activeInterval = null;
        run();
      } else {
        elapsed += 250;
        if (elapsed >= 10000) {
          clearInterval(activeInterval);
          activeInterval = null;
          console.warn(`[md] Timed out waiting for selector: ${selector}`);
        }
      }
    }, 250);
  } else {
    run();
  }
}

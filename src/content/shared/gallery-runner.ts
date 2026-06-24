import type { MDConfig } from "../../types/global";
import type { HosterModel } from "../../types/hoster";
import type { GalleryJobItem, MDGalleryStartRequest } from "../../types/messages";
import type { GalleryCtx } from "./gallery-ui";
import { thumbnailToFull } from "../../resolvers/index";
import {
  parseSet,
  deriveGalleryName,
  compareSetsByDateAndSubfolder,
} from "../../hosts/girlsreleased/api";
import { sanitizeFilename } from "../../background/sanitize";
import {
  collectThumbnailTransform,
  collectAnchorHref,
  collectResolveViewer,
  collectPageUrls,
  fetchAdditionalItems,
} from "./collector";

function buildSubfolder(albumName: string, config: MDConfig): string {
  if (!config.autoFolderPerAlbum) return config.downloadDirectory;
  const safeName = albumName
    .split("/")
    .map((seg) => sanitizeFilename(seg))
    .join("/");
  return config.downloadDirectory ? `${config.downloadDirectory}/${safeName}` : safeName;
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
      doneIcon: string,
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
        let lastJobId = "";

        // Fetch all sets' API data in parallel
        const setResults = await Promise.all(
          jobItems.map(async (item) => {
            if (item.kind === "resolve-viewer" && item.viewerUrl.includes("/set/")) {
              try {
                const setIdMatch = /\/set\/(\d+)/.exec(item.viewerUrl);
                const setId = setIdMatch?.[1];
                if (!setId) return null;

                const res = await fetch(`/api/0.2/set/${setId}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();

                const parsed = parseSet(data);
                if (!parsed) return null;

                const detectedSetName = deriveGalleryName(
                  parsed.site,
                  parsed.model,
                  parsed.name,
                  parsed.postedAt,
                );
                const setSubfolder = detectedSetName ? buildSubfolder(detectedSetName, config) : "";

                const setItems: GalleryJobItem[] = [];
                for (const file of parsed.files) {
                  const fullUrl = thumbnailToFull(file.thumbnailUrl);
                  if (fullUrl) {
                    setItems.push({
                      kind: "resolved",
                      imageUrl: fullUrl,
                      filename: file.filename,
                      subfolder: setSubfolder,
                    });
                  } else {
                    setItems.push({
                      kind: "resolve-viewer",
                      viewerUrl: file.viewerUrl,
                      filename: file.filename,
                      subfolder: setSubfolder,
                    });
                  }
                }

                if (setItems.length > 0) {
                  const setJobId = crypto.randomUUID();
                  const req: MDGalleryStartRequest = {
                    type: "MD_GALLERY_START",
                    jobId: setJobId,
                    hosterId: model.id,
                    subfolder: setSubfolder,
                    items: setItems,
                    maxParallelImg: config.maxParallelImg,
                    maxParallelVid: config.maxParallelVid,
                    postedAt: parsed.postedAt ?? undefined,
                  };
                  return { req, postedAt: parsed.postedAt ?? 0 };
                }
              } catch (err) {
                console.error(`[md] failed to crawl set ${item.viewerUrl}:`, err);
              }
            }
            return null;
          }),
        );

        // Filter valid results and sort by postedAt descending (latest date first), and subfolder ascending
        const validResults = setResults.filter(
          (r): r is { req: MDGalleryStartRequest; postedAt: number } => r !== null,
        );
        validResults.sort((a, b) => {
          return compareSetsByDateAndSubfolder(
            { postedAt: a.postedAt, subfolder: a.req.subfolder },
            { postedAt: b.postedAt, subfolder: b.req.subfolder },
          );
        });

        // Post messages sequentially
        for (const res of validResults) {
          window.postMessage(res.req, "*");
          lastJobId = res.req.jobId;
        }

        btnElement.innerHTML = doneIcon;
        return lastJobId;
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

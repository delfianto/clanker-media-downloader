import type { MDConfig } from "../../types/global";
import type { GalleryConfig, HosterModel } from "../../types/hoster";
import type { GalleryJobItem, MDGalleryStartRequest } from "../../types/messages";
import { createDownloadAllButton, injectGalleryStyles } from "./gallery-ui";

function buildSubfolder(albumName: string, config: MDConfig): string {
  if (!config.autoFolderPerAlbum) return config.downloadDirectory;
  const safeName = albumName.replace(new RegExp('[/\\\\:*?"<>|]', "g"), "_").trim();
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

function collectThumbnailTransform(gc: GalleryConfig): GalleryJobItem[] {
  const src = gc.imageSource;
  if (src.strategy !== "thumbnail-transform") return [];
  const imgs = Array.from(document.querySelectorAll<HTMLImageElement>(src.selector));
  return imgs
    .map((img) => img.src)
    .filter(Boolean)
    .map((thumbSrc) => {
      const imageUrl = src.buildUrl(thumbSrc);
      return { kind: "resolved" as const, imageUrl, filename: basenameFromUrl(imageUrl) };
    });
}

// ── Strategy: anchor-href ────────────────────────────────────────────────────

function collectAnchorHref(gc: GalleryConfig): GalleryJobItem[] {
  const src = gc.imageSource;
  if (src.strategy !== "anchor-href") return [];
  const imgs = Array.from(document.querySelectorAll<HTMLImageElement>(src.imageSelector));
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

function collectResolveViewer(gc: GalleryConfig): GalleryJobItem[] {
  const src = gc.imageSource;
  if (src.strategy !== "resolve-viewer") return [];
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>(src.anchorSelector));
  return anchors
    .filter((a) => !!a.href)
    .map((a) => {
      const viewerUrl = a.href;
      let filename = viewerUrl.split("/").at(-1) ?? "file";
      if (src.filenameSelector) {
        const nameEl = a.querySelector(src.filenameSelector);
        if (nameEl?.textContent) {
          filename = nameEl.textContent.trim();
        }
      }
      const item: GalleryJobItem = {
        kind: "resolve-viewer",
        viewerUrl,
        extractor: src.extractor,
        filename,
      };
      if (src.needsSign) {
        return { ...item, needsSign: true as const };
      }
      return item;
    });
}

// ── Main entry ───────────────────────────────────────────────────────────────

export function runGalleryAdapter(model: HosterModel, config: MDConfig): void {
  const gc = model.galleryConfig;
  if (!gc) return;

  const albumIdMatch = new RegExp(gc.albumIdFromPath).exec(location.pathname);
  const albumId = albumIdMatch?.[1] ?? location.pathname.split("/").at(-1) ?? "album";

  const albumName = model.getGalleryName
    ? (model.getGalleryName(document) ?? albumId)
    : (document.querySelector(gc.albumNameSelector)?.textContent?.trim() ?? albumId);

  let items: GalleryJobItem[];
  switch (gc.imageSource.strategy) {
    case "thumbnail-transform":
      items = collectThumbnailTransform(gc);
      break;
    case "anchor-href":
      items = collectAnchorHref(gc);
      break;
    case "resolve-viewer":
      items = collectResolveViewer(gc);
      break;
  }

  if (items.length === 0) return;

  const note =
    gc.imageSource.strategy === "anchor-href"
      ? "Current page only — pagination not yet supported"
      : undefined;

  const subfolder = buildSubfolder(albumName, config);

  const viewSwitches = document.querySelector(".view-switches");
  if (model.id === "imagebam" && viewSwitches) {
    injectGalleryStyles();
    const dlBtn = document.createElement("a");
    dlBtn.href = "javascript:void(0);";
    dlBtn.className = "md-ib-gallery-btn";
    dlBtn.title = "Download Gallery";
    dlBtn.innerHTML = '<i class="fa fa-download"></i>';

    let activeJobId = "";
    dlBtn.addEventListener("click", () => {
      if (activeJobId) return;
      activeJobId = crypto.randomUUID();
      dlBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i>';
      dlBtn.classList.add("loading");

      const req: MDGalleryStartRequest = {
        type: "MD_GALLERY_START",
        jobId: activeJobId,
        hosterId: model.id,
        subfolder,
        items,
        maxParallel: config.maxParallel,
      };
      window.postMessage(req, "*");
    });

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const data = event.data as Record<string, unknown>;
      if (data["type"] === "MD_JOB_PROGRESS" && data["jobId"] === activeJobId) {
        const status = data["status"];
        if (status === "done" || status === "error") {
          dlBtn.innerHTML = '<i class="fa fa-download"></i>';
          dlBtn.classList.remove("loading");
          activeJobId = "";
        }
      }
    });

    viewSwitches.prepend(dlBtn);
    return;
  }

  const wrap = createDownloadAllButton(items.length, note, () => {
    const req: MDGalleryStartRequest = {
      type: "MD_GALLERY_START",
      jobId: crypto.randomUUID(),
      hosterId: model.id,
      subfolder,
      items,
      maxParallel: config.maxParallel,
    };
    window.postMessage(req, "*");
  });

  // Inject the button before the gallery content.
  // Try a few common gallery container selectors; fall back to document.body.
  const container =
    document.querySelector("#container, .gallery, [class*='gallery'], main, article") ??
    document.body;
  container.prepend(wrap);

  // Update button label to show album name if we found one.
  const btn = wrap.querySelector("button");
  if (btn && albumName !== albumId) {
    btn.textContent = `⬇ Download "${albumName}" (${items.length})`;
  }
}

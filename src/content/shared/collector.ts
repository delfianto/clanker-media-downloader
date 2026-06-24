import type { GalleryConfig } from "../../types/hoster";
import type { GalleryJobItem } from "../../types/messages";

export function basenameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    return path.split("/").at(-1) ?? "file";
  } catch {
    return "file";
  }
}

export function collectThumbnailTransform(
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

export function collectAnchorHref(
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

export function collectResolveViewer(
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

export function collectPageUrls(): string[] {
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

export async function fetchAdditionalItems(
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

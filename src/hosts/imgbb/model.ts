import type { GalleryJobItem } from "../../types/messages";
import type { HosterModel } from "../../types/hoster";

// imgbb embeds each image's full metadata as a URL-encoded JSON in a
// data-object attribute on the .list-item element. The <img> in the DOM
// shows the "medium" (compressed preview) URL — we need the "image" (full-res)
// URL from data-object instead.

interface ImgBBObject {
  image?: { url?: string; filename?: string };
  medium?: { url?: string };
  thumb?: { url?: string };
  filename?: string;
  url?: string;
  url_viewer?: string;
}

function collectImgbbItems(root?: Document | Element): GalleryJobItem[] {
  const scope = root ?? document;
  const items = Array.from(scope.querySelectorAll<HTMLElement>(".list-item"));
  const result: GalleryJobItem[] = [];
  for (const item of items) {
    const raw = item.getAttribute("data-object");
    if (!raw) continue;
    try {
      const decoded = decodeURIComponent(raw);
      const obj = JSON.parse(decoded) as ImgBBObject;
      const imageUrl = obj.image?.url;
      if (!imageUrl) continue;
      const filename = obj.image?.filename ?? obj.filename ?? imageUrl.split("/").at(-1) ?? "file";
      result.push({ kind: "resolved", imageUrl, filename });
    } catch {
      // Not valid JSON — skip
    }
  }
  console.log(`[md] ImgBB: found ${result.length} items from data-object`);
  return result;
}

export const imgbbModel: HosterModel = {
  id: "imgbb",
  displayName: "ImgBB",
  viewerMatches: ["https://ibb.co/*"],
  cdnMatches: [],
  defaultRedirectRules: [],
  downloadConfig: {
    buttonSelector: "a.btn-download",
    filenameStrategy: { type: "dom", selector: "a.btn-download", attr: "download" },
    uiMode: "button-overlay",
  },
  defaultCssOverrides: "",
  galleryConfig: {
    galleryMatches: ["https://ibb.co/album/*"],
    albumNameSelector: "h1",
    albumIdFromPath: "^/album/([^/?]+)",
    imageSource: {
      strategy: "anchor-href",
      // Fallback only — collectAllItems reads data-object for full-res URLs.
      imageSelector: ".image-container img",
    },
    collectAllItems: collectImgbbItems,
  },
  getGalleryName: (doc: Document) => {
    // imgbb's <h1> truncates the album name with a literal "..." suffix (CSS
    // text-overflow). The full name is in the breadcrumb <a data-text="album-name">.
    const breadcrumb = doc.querySelector<HTMLAnchorElement>('a[data-text="album-name"]');
    return breadcrumb?.textContent?.trim() ?? null;
  },
};

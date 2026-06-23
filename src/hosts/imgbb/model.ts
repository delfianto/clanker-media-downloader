import type { HosterModel } from "../../types/hoster";

// imgbb's displayed image is a compressed preview; the download link points at
// the full-res original on i.ibb.co — a different resource, so a cache hit on
// the second download is not expected. No CDN redirect: imgbb thumbnails on
// external sites already link straight to the ibb.co viewer page.
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
      // Album grid: <a href="https://ibb.co/{id}"><img src="https://i.ibb.co/{hash}/{name}.jpg"></a>
      // The img.src IS the full-res URL — no transform needed.
      imageSelector: "div.image-container img",
    },
  },
};

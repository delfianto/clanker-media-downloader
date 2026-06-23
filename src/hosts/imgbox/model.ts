import type { HosterModel } from "../../types/hoster";

export const imgboxModel: HosterModel = {
  id: "imgbox",
  displayName: "ImgBox",
  viewerMatches: ["https://imgbox.com/*"],
  cdnMatches: ["https://thumbs*.imgbox.com/*", "https://images*.imgbox.com/*"],
  defaultRedirectRules: [
    {
      id: "imgbox-main",
      description: "Thumbnail/image CDN redirect",
      pattern:
        "^https?://(?:thumbs|images)\\d+\\.imgbox\\.com(?:/[a-f0-9]{2}){2}/([a-zA-Z0-9]{8,})_[bot]\\.(gif|jpe?g|png)$",
      template: "https://imgbox.com/$1",
      enabled: true,
    },
  ],
  downloadConfig: {
    buttonSelector: ".icon-cloud-download",
    imageSelector: "#img",
    filenameStrategy: { type: "dom", selector: ".image-content", attr: "title" },
    uiMode: "button-overlay",
    pathGuard: "^/[a-zA-Z0-9]{8}$",
  },
  defaultCssOverrides: "",
  galleryConfig: {
    galleryMatches: ["https://imgbox.com/g/*"],
    albumNameSelector: "h1",
    albumIdFromPath: "^/g/([a-zA-Z0-9]+)$",
    imageSource: {
      strategy: "thumbnail-transform",
      // Gallery grid: <a href="/{id}"><img src="https://thumbs2.imgbox.com/b9/a3/{id}_b.jpg"></a>
      // _b (big thumb) → _o (original); thumbsN.imgbox.com → imagesN.imgbox.com
      selector: "div#container img",
      buildUrl: (thumb: string) =>
        thumb.replace(/thumbs(\d*)\.imgbox\.com/, "images$1.imgbox.com").replace(/_[bt]\./, "_o."),
    },
  },
};

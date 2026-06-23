import type { HosterModel } from "../../types/hoster";

export const imagebamModel: HosterModel = {
  id: "imagebam",
  displayName: "ImageBam",
  viewerMatches: ["https://www.imagebam.com/image/*", "https://www.imagebam.com/view/*"],
  cdnMatches: ["https://thumbs*.imagebam.com/*", "https://images*.imagebam.com/*"],
  defaultRedirectRules: [
    {
      id: "imagebam-new",
      description: "New format (uppercase ID, _o/_t suffix)",
      pattern:
        "^https?://(?:thumbs|images)\\d+\\.imagebam\\.com(?:/[a-f0-9]{2}){3}/([A-Z0-9]{7,})_[ot]\\.(gif|jpe?g|png)$",
      template: "https://www.imagebam.com/view/$1",
      enabled: true,
    },
    {
      id: "imagebam-old",
      description: "Old format (lowercase ID, no suffix)",
      pattern:
        "^https?://(?:images|thumbs)\\d\\.imagebam\\.com/(?:[a-f0-9]{2}/){3}([a-z0-9]+)\\.(png|jpe?g|gif)$",
      template: "https://www.imagebam.com/image/$1",
      enabled: true,
    },
  ],
  downloadConfig: {
    buttonSelector: 'a.dropdown-item[target="_blank"]',
    imageSelector: "img.main-image",
    filenameStrategy: { type: "uuid-fallback", domSelector: "span.name.text-ellipsis" },
    uiMode: "inline-after",
  },
  defaultCssOverrides: "",
  galleryConfig: {
    // Imagebam gallery pages share /view/* with single-image viewer pages.
    // viewerIndicator tells isolated.ts: if img.main-image is ABSENT → gallery page.
    galleryMatches: ["https://www.imagebam.com/view/*"],
    viewerIndicator: "img.main-image",
    albumNameSelector: "h1",
    albumIdFromPath: "^/(?:view|gallery)/([A-Z0-9]+)$",
    imageSource: {
      strategy: "resolve-viewer",
      // Gallery thumbnail list: <li><img src="thumbs4..."><a href="/view/{imgId}">...</a></li>
      anchorSelector: "li a[href*='/view/']",
      // SW fetches each viewer page HTML; group 1 = the CDN src on img.main-image
      extractor: 'img\\.main-image[^>]+src="([^"]+)"',
    },
  },
};

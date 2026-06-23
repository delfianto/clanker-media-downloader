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
      // Gallery grid contains links to viewer pages like <a href=".../view/ID" class="thumbnail">
      // with filename inside <span class="title">.
      anchorSelector: "a.thumbnail",
      filenameSelector: ".title",
      extractor: '<img src="([^"]+)"[^>]*class="main-image',
    },
  },
  getGalleryName: (doc: Document) => {
    const galleryNameEl = doc.querySelector("#gallery-name");
    if (galleryNameEl?.textContent) {
      return galleryNameEl.textContent.trim();
    }
    const backLink = Array.from(doc.querySelectorAll("a")).find(
      (a) => a.textContent?.includes("Back to gallery") || !!a.querySelector(".fa-reply"),
    );
    if (backLink) {
      const href = backLink.getAttribute("href");
      if (href) {
        return new URL(href, doc.baseURI || location.href).href;
      }
    }
    return null;
  },
};

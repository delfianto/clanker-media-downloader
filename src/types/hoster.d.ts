// HosterModel and its constituent shapes — the single source of truth for each
// site's defaults (redirect rules, download selectors, filename strategy).
// HosterId is defined here (the primitive) and re-exported from global.d.ts so
// settings code can import it from either place.

export type HosterId = "imagebam" | "imgbox" | "imgbb" | "bunkr";

export type RedirectRule = {
  id: string; // stable slug for user-override keying, e.g. "imagebam-new"
  description: string; // shown in the options UI
  pattern: string; // regex string, run in JS via new RegExp(pattern, "i")
  template: string; // redirect URL template — $1/$2 reference capture groups
  enabled: boolean;
};

export type FilenameStrategy =
  | { type: "dom"; selector: string; attr?: string } // read text/attr from a DOM node
  | { type: "url-slug" } // last path segment of location.href
  | { type: "uuid-fallback"; domSelector: string }; // imagebam: prefer slug when name is a UUID

export type DownloadConfig = {
  buttonSelector: string; // the existing download control to hijack
  imageSelector?: string; // displayed image, used to prefer a cache-warm URL
  filenameStrategy: FilenameStrategy;
  uiMode: "inline-after" | "button-overlay"; // where feedback UI attaches
  pathGuard?: string; // runtime regex on location.pathname before activating (imgbox)
};

// ── Gallery support ──────────────────────────────────────────────────────────

// How to extract full-res image URLs from a gallery page's DOM.
// buildUrl is a pure function (never stored in chrome.storage) so it can contain
// arbitrary transform logic (e.g. the imgbox hostname + suffix swap).
export type GalleryImageSource =
  | {
      strategy: "thumbnail-transform";
      selector: string; // CSS selector for <img> elements in the gallery grid
      buildUrl: (thumbSrc: string) => string; // pure fn: thumb URL → full-res URL
    }
  | {
      strategy: "anchor-href";
      imageSelector: string; // CSS selector for <img> elements whose .src IS the full-res URL
    }
  | {
      strategy: "resolve-viewer";
      anchorSelector: string; // CSS selector for <a> links to viewer pages
      extractor: string; // regex string sent to SW: group 1 = raw CDN URL in viewer HTML
      needsSign?: true; // bunkr only: SW must call sign API after extraction
    };

export type GalleryConfig = {
  galleryMatches: string[]; // manifest content_scripts matches for gallery pages
  // imagebam only: selector PRESENT on viewer pages, ABSENT on gallery pages.
  // Used to distinguish them since both share /view/* URL pattern.
  // Confirmed: gallery pages have no img.main-image element.
  viewerIndicator?: string;
  albumNameSelector: string; // CSS selector for the album/gallery title text node
  albumIdFromPath: string; // regex on location.pathname — group 1 = album id for subfolder
  imageSource: GalleryImageSource;
};

export type HosterModel = {
  id: HosterId;
  displayName: string;
  viewerMatches: string[]; // manifest content_scripts matches — viewer pages
  cdnMatches: string[]; // manifest content_scripts matches — CDN domains (redirect)
  defaultRedirectRules: RedirectRule[];
  downloadConfig: DownloadConfig;
  defaultCssOverrides: string; // empty string when none
  galleryConfig?: GalleryConfig; // undefined = no gallery support for this hoster
};

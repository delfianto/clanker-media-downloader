// HosterModel and its constituent shapes — the single source of truth for each
// site's defaults (redirect rules, download selectors, filename strategy).
// HosterId is defined here (the primitive) and re-exported from global.d.ts so
// settings code can import it from either place.

import type { GalleryJobItem } from "./messages";

export type HosterId =
  | "imagebam"
  | "imgbox"
  | "imgbb"
  | "bunkr"
  | "erome"
  | "jpg6"
  | "girlsreleased";

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
      filenameSelector?: string; // CSS selector (relative to the anchor) to locate the filename text
    };

// Optional hooks the SW calls during viewer-page resolution. These let each
// hoster own its peculiarities (bunkr signing, video <source> fallback, etc.)
// without the SW knowing hoster-specific details.

// Parse the raw media URL from viewer page HTML. Overrides the regex extractor.
// Can also return a filename override. Return null to fall back to the regex.
export type ExtractFromViewer = (html: string) => { url: string; filename?: string } | null;

// Transform a raw CDN URL into a downloadable URL (e.g. call a sign API).
// If absent, the raw URL is used directly.
export type ResolveUrl = (
  rawUrl: string,
  viewerUrl?: string,
) => Promise<string | { url: string; filename?: string }>;

// A resolve-viewer item whose URL must be derived by the host itself (it fetches
// the viewer page however it needs to — POST interstitial, credentialed GET, etc.).
// When present, the framework does NOT pre-fetch the viewer page; this hook is the
// sole authority. Mutually exclusive with extractFromViewer in practice.
export type ResolveFromViewer = (viewerUrl: string) => Promise<{ url: string; filename?: string }>;

export type GalleryConfig = {
  galleryMatches: string[]; // manifest content_scripts matches for gallery pages
  // imagebam only: selector PRESENT on viewer pages, ABSENT on gallery pages.
  // Used to distinguish them since both share /view/* URL pattern.
  // Confirmed: gallery pages have no img.main-image element.
  viewerIndicator?: string;
  albumNameSelector: string; // CSS selector for the album/gallery title text node
  albumIdFromPath: string; // regex on location.pathname — group 1 = album id for subfolder
  imageSource: GalleryImageSource;
  // Optional: collect all gallery items from MAIN world. For hosters where items
  // are loaded dynamically via JS (e.g. Bunkr's window.albumFiles), this bypasses
  // DOM-scraping strategies and returns the complete item list directly.
  // Runs in MAIN world so it has full access to page JS globals.
  // When root is provided, queries against it instead of document (used by
  // fetchAdditionalItems for paginated pages).
  collectAllItems?: (root?: Document | Element) => GalleryJobItem[];
  // Optional SW-side hooks (see type docs above).
  extractFromViewer?: ExtractFromViewer;
  resolveUrl?: ResolveUrl;
  resolveFromViewer?: ResolveFromViewer;
  // Optional: test whether a gallery item's filename is "bizarre" (UUID,
  // mojibake, etc.). When the user enables "Use Fallback Name" for this
  // hoster, items whose filename matches this test use the file ID from the
  // anchor href instead.
  isBizarreName?: (name: string) => boolean;
  pathGuard?: string; // runtime regex on location.pathname before activating (jpg6 / user pages)
  waitForSelector?: string; // wait for this selector to exist in DOM before running gallery adapter
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
  getGalleryName?: (doc: Document) => string | null; // Abstraction to detect gallery name/ID from page DOM
};

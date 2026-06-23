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

export type HosterModel = {
  id: HosterId;
  displayName: string;
  viewerMatches: string[]; // manifest content_scripts matches — viewer pages
  cdnMatches: string[]; // manifest content_scripts matches — CDN domains (redirect)
  defaultRedirectRules: RedirectRule[];
  downloadConfig: DownloadConfig;
  defaultCssOverrides: string; // empty string when none
};

import type { HosterModel } from "../../types/hoster";

export const bunkrModel: HosterModel = {
  id: "bunkr",
  displayName: "Bunkr",
  viewerMatches: [
    "https://bunkr.site/f/*",
    "https://bunkr.su/f/*",
    "https://bunkr.is/f/*",
    "https://bunkr.black/f/*",
    "https://bunkr.fi/f/*",
    "https://bunkr.ac/f/*",
    "https://bunkr.cat/f/*",
    "https://bunkr.ws/f/*",
    "https://bunkr.ph/f/*",
    "https://bunkr.red/f/*",
    "https://bunkr.media/f/*",
    "https://bunkr.cr/f/*",
  ],
  cdnMatches: [],
  defaultRedirectRules: [],
  downloadConfig: {
    // The "Download" CTA on the viewer page — we hijack its click to bypass the dl.bunkr hop.
    buttonSelector: "a.btn-main.ic-download-01",
    // Page JS signs jsCDN async and sets this src; we read it at click time, not activate time.
    imageSelector: "#img-main",
    filenameStrategy: { type: "dom", selector: "h1" },
    uiMode: "button-overlay",
  },
  defaultCssOverrides: "",
};

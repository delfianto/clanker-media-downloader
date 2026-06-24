import type { GalleryJobItem } from "../../types/messages";
import type { HosterModel } from "../../types/hoster";
import { resolveLeaf } from "../../resolvers/index";
import { deriveGalleryName } from "./api";

function collectGirlsreleasedItems(root?: Document | Element): GalleryJobItem[] {
  const isSitePage =
    !root && typeof window !== "undefined" && window.location.pathname.includes("/site/");

  if (isSitePage) {
    const scope = root ?? document;
    const anchors = Array.from(scope.querySelectorAll<HTMLAnchorElement>("a"));
    const items: GalleryJobItem[] = [];
    const visited = new Set<string>();

    for (const anchor of anchors) {
      const href = anchor.href;
      if (!href) continue;

      const isSetLink = /\/set\/[^/?]+/.test(href);
      if (isSetLink && !visited.has(href)) {
        visited.add(href);
        items.push({
          kind: "resolve-viewer",
          viewerUrl: href,
          filename: "set_placeholder",
        });
      }
    }
    console.log(`[md] GirlsReleased: found ${items.length} set pages to crawl`);
    return items;
  }

  // Direct set page — emit a single self-referential item to trigger set expansion
  const urlToUse = !root ? window.location.href : "";
  if (urlToUse && urlToUse.includes("/set/")) {
    return [
      {
        kind: "resolve-viewer",
        viewerUrl: urlToUse,
        filename: "set_placeholder",
      },
    ];
  }

  return [];
}

export const girlsreleasedModel: HosterModel = {
  id: "girlsreleased",
  displayName: "GirlsReleased",
  viewerMatches: [],
  cdnMatches: [],
  defaultRedirectRules: [],
  downloadConfig: {
    buttonSelector: "",
    filenameStrategy: { type: "url-slug" },
    uiMode: "button-overlay",
  },
  defaultCssOverrides: "",
  galleryConfig: {
    galleryMatches: [
      "https://girlsreleased.com/set/*",
      "https://*.girlsreleased.com/set/*",
      "https://girlsreleased.com/site/*",
      "https://*.girlsreleased.com/site/*",
    ],
    albumNameSelector: "h1",
    albumIdFromPath: "^/(?:set|site)/([^/?]+)",
    waitForSelector: "a[href*='imx.to/i/'], a[href*='/set/']",
    imageSource: {
      strategy: "anchor-href",
      imageSelector: "#root img",
    },
    collectAllItems: collectGirlsreleasedItems,
    resolveFromViewer: resolveLeaf,
  },
  getGalleryName: (doc: Document) => {
    // 1. Find the visible h1 (the set name)
    const visibleH1 = Array.from(doc.querySelectorAll("h1")).find((el) => {
      const style = el.getAttribute("style") || "";
      const text = el.textContent?.trim() || "";
      return !style.includes("display: none") && text !== "about 0";
    });
    const setName = visibleH1 ? visibleH1.textContent?.trim() || "" : doc.title?.trim() || "";

    // 2. Find site links that are not in navigation/header
    const siteLinks = Array.from(
      doc.querySelectorAll<HTMLAnchorElement>('a[href*="/site/"]'),
    ).filter((a) => !a.closest("nav") && !a.closest("header"));

    const siteLink = siteLinks.find((a) => {
      const href = a.getAttribute("href") || "";
      return href.startsWith("/site/") && !href.includes("/model/");
    });
    const modelLink = siteLinks.find((a) => {
      const href = a.getAttribute("href") || "";
      return href.startsWith("/site/") && href.includes("/model/");
    });

    let siteName = "";
    if (siteLink) {
      const text = siteLink.textContent?.trim() || "";
      const href = siteLink.getAttribute("href") || "";
      const match = /\/site\/([^/?]+)/.exec(href);
      const rawSite = match?.[1] || text;
      siteName = rawSite;
    }

    let modelName = "";
    if (modelLink) {
      modelName = modelLink.textContent?.trim() || "";
    }

    return deriveGalleryName(siteName, modelName, setName) || null;
  },
};

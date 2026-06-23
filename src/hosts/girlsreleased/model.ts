import type { GalleryJobItem } from "../../types/messages";
import type { HosterModel } from "../../types/hoster";

function collectGirlsreleasedItems(root?: Document | Element): GalleryJobItem[] {
  const scope = root ?? document;
  const isSitePage = !root && window.location.pathname.includes("/site/");

  const anchors = Array.from(scope.querySelectorAll<HTMLAnchorElement>("a"));
  const items: GalleryJobItem[] = [];
  const visited = new Set<string>();

  const titleNode = scope.querySelector("h1") || document.querySelector("title");
  const albumName = titleNode?.textContent?.trim() || "girlsreleased";
  const normalizedAlbumName = albumName
    .replace(/\s+/g, "_")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");

  if (isSitePage) {
    for (const anchor of anchors) {
      const href = anchor.href;
      if (!href) continue;

      const isSetLink = /\/set\/[^/?]+/.test(href);
      if (isSetLink && !visited.has(href)) {
        visited.add(href);
        items.push({
          kind: "resolve-viewer",
          viewerUrl: href,
          extractor: "continuebutton",
          filename: "set_placeholder",
        });
      }
    }
    console.log(`[md] GirlsReleased: found ${items.length} set pages to crawl`);
    return items;
  }

  let idx = 0;
  for (const anchor of anchors) {
    const href = anchor.href;
    if (!href) continue;

    const isSupportedHost = href.includes("imx.to/i/");
    if (isSupportedHost && !visited.has(href)) {
      visited.add(href);
      idx++;
      const num = String(idx).padStart(3, "0");
      const filename = `${normalizedAlbumName}_${num}`;

      items.push({
        kind: "resolve-viewer",
        viewerUrl: href,
        extractor: "continuebutton",
        filename,
      });
    }
  }

  console.log(`[md] GirlsReleased: found ${items.length} items from viewer links`);
  return items;
}

async function resolveGirlsreleasedUrl(
  rawUrl: string,
  viewerUrl?: string,
): Promise<string | { url: string; filename?: string }> {
  if (!viewerUrl) return rawUrl;

  if (viewerUrl.includes("imx.to/i/")) {
    const payload = new URLSearchParams();
    payload.append("imgContinue", "Continue to your image...");

    const res = await fetch(viewerUrl, {
      method: "POST",
      body: payload,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to POST to imx.to! HTTP ${res.status}`);
    }

    const html = await res.text();
    const imgMatch = html.match(/<img[^>]+src=["'](https:\/\/[^"']+\.(?:jpg|jpeg|png))["']/i);
    if (!imgMatch?.[1]) {
      throw new Error("Failed to parse direct image URL from imx.to POST response");
    }

    const titleMatch = html.match(/<title>(?:IMX\.to\s*\/)?\s*([^<]+)<\/title>/i);
    const filename = titleMatch?.[1]?.trim();

    return filename ? { url: imgMatch[1], filename } : imgMatch[1];
  }

  if (viewerUrl.includes("imagevenue.com")) {
    // ImageVenue has an interstitial on first fetch. The SW already did one GET
    // (in resolveItem), so cookies should be set. Second fetch gets the real page.
    const res = await fetch(viewerUrl, { credentials: "include" });
    if (!res.ok) throw new Error(`ImageVenue HTTP ${res.status}`);
    const html = await res.text();

    // Look for the main image — typically <img class="img-fluid" src="...">
    const imgMatch =
      html.match(
        /<img[^>]+class=["'][^"]*img-fluid[^"]*["'][^>]+src=["'](https?:\/\/[^"']+)["']/i,
      ) ||
      html.match(/<img[^>]+src=["'](https?:\/\/cdn[^"']+\.(?:jpg|jpeg|png|gif|webp)[^"']*)["']/i) ||
      html.match(/property=["']og:image["'][^>]+content=["'](https?:\/\/[^"']+)["']/i);

    if (imgMatch?.[1]) {
      const titleMatch = html.match(/<title>[^<]*?-\s*([^<]+)<\/title>/i);
      const filename = titleMatch?.[1]?.trim();
      return filename ? { url: imgMatch[1], filename } : imgMatch[1];
    }
    throw new Error("Failed to extract image URL from ImageVenue page");
  }

  return rawUrl;
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
    resolveUrl: resolveGirlsreleasedUrl,
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
      if (rawSite) {
        const nameWithoutTld = rawSite.replace(/\.[a-z]{2,6}$/i, "");
        siteName = nameWithoutTld.charAt(0).toUpperCase() + nameWithoutTld.slice(1);
      }
    }

    let modelName = "";
    if (modelLink) {
      modelName = modelLink.textContent?.trim() || "";
    }

    const cleanSetName = setName.replace(/\s*\/\s*/g, " - ");

    if (siteName) {
      if (modelName) {
        return `${siteName}/${modelName} - ${cleanSetName}`;
      } else {
        return `${siteName}/${cleanSetName}`;
      }
    }
    return cleanSetName || null;
  },
};

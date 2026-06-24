import type { GalleryJobItem } from "../../types/messages";
import type { HosterModel, CrawlResult } from "../../types/hoster";
import type { MDConfig } from "../../types/global";
import { resolveLeaf, thumbnailToFull } from "../../resolvers/index";
import { parseSet, deriveGalleryName, compareSetsByDateAndSubfolder } from "./api";
import { buildSubfolder } from "../../content/shared/collector";

function collectSetAnchorsFromRoot(root: Document | Element): GalleryJobItem[] {
  const anchors = Array.from(root.querySelectorAll<HTMLAnchorElement>("a"));
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
  return items;
}

// Paginate the girlsreleased listing API to discover every set for a site (and
// optionally a specific model), not just the first page the SPA rendered into
// the DOM. The SPA only fetches page 1 on initial load and gates further pages
// behind a JS "Load More" button (no real <a href> pagination links), so DOM
// scraping alone would miss every set past page 1.
//
// Endpoint (matches the SPA's own Sg builder + useNgApi path):
//   /api/0.3/sets/site/{site}/sort/date/page/{n}
//   /api/0.3/sets/site/{site}/model/{modelId}/sort/date/page/{n}
//
// The API returns up to 101 entries per non-final page. The 101st entry is a
// peek-ahead sentinel that duplicates page N+1's first entry — the SPA drops
// it client-side (sets.slice(0,-1) when length>100). We dedupe by set id so the
// overlap never produces a duplicate crawl item. A page returning ≤100 entries
// (or an empty sets array) signals the last page and stops pagination.
async function collectAllSetsViaApi(site: string, modelId?: string): Promise<GalleryJobItem[]> {
  const base = modelId
    ? `/api/0.3/sets/site/${encodeURIComponent(site)}/model/${encodeURIComponent(modelId)}/sort/date/page/`
    : `/api/0.3/sets/site/${encodeURIComponent(site)}/sort/date/page/`;

  const items: GalleryJobItem[] = [];
  const seenIds = new Set<number>();
  const MAX_PAGES = 200; // safety cap against runaway pagination

  for (let page = 1; page <= MAX_PAGES; page++) {
    let data: { sets?: unknown[] };
    try {
      const res = await fetch(`${base}${page}`);
      if (!res.ok) {
        console.warn(
          `[md] GirlsReleased: API page ${page} returned HTTP ${res.status}, stopping pagination`,
        );
        break;
      }
      data = await res.json();
    } catch (err) {
      console.warn(
        `[md] GirlsReleased: failed to fetch API page ${page}, stopping pagination:`,
        err,
      );
      break;
    }

    const sets = data.sets;
    if (!Array.isArray(sets) || sets.length === 0) break;

    for (const entry of sets) {
      if (!Array.isArray(entry)) continue;
      const rawId = entry[0];
      const id = typeof rawId === "number" ? rawId : Number(rawId);
      if (!Number.isFinite(id) || seenIds.has(id)) continue;
      seenIds.add(id);
      items.push({
        kind: "resolve-viewer",
        viewerUrl: `https://girlsreleased.com/set/${id}`,
        filename: "set_placeholder",
      });
    }

    if (sets.length <= 100) break; // last page
  }

  console.log(`[md] GirlsReleased: discovered ${items.length} sets via API pagination for ${site}`);
  return items;
}

async function collectGirlsreleasedItems(root?: Document | Element): Promise<GalleryJobItem[]> {
  // Root-provided path: HTML-pagination fallback (used by fetchAdditionalItems
  // when collectPageUrls finds real pagination links). The girlsreleased SPA
  // drives pagination via a JS "Load More" button rather than real <a href>
  // links, so this path is rarely hit in practice — but kept for safety.
  if (root) {
    return collectSetAnchorsFromRoot(root);
  }

  if (typeof window === "undefined") return [];

  const path = window.location.pathname;

  // /site/{site}[/model/{id}/{name}] — paginate the API to discover ALL sets.
  const siteMatch = /^\/site\/([^/]+)(?:\/model\/([^/]+))?/.exec(path);
  if (siteMatch) {
    const [, site, modelId] = siteMatch;
    // siteMatch[1] is always present on a successful match (the regex requires
    // at least one non-slash char), but noUncheckedIndexedAccess types it as
    // string | undefined — guard to satisfy the type and stay honest.
    if (site) return collectAllSetsViaApi(site, modelId);
  }

  // Direct /set/NNN page — emit a single self-referential item to trigger set
  // expansion via the crawl hook (crawlGirlsreleasedSet below).
  if (path.includes("/set/")) {
    return [
      {
        kind: "resolve-viewer",
        viewerUrl: window.location.href,
        filename: "set_placeholder",
      },
    ];
  }

  return [];
}

// ── Crawl hook ───────────────────────────────────────────────────────────────
// All girlsreleased-specific crawl knowledge lives here, not in the shared
// gallery runner. The shared runner calls isCrawlItem to detect crawl items,
// crawlItem to expand each one, and sortCrawlResults to order the results.

function isGirlsreleasedSetItem(item: GalleryJobItem): boolean {
  return item.kind === "resolve-viewer" && item.viewerUrl.includes("/set/");
}

async function crawlGirlsreleasedSet(
  item: GalleryJobItem,
  model: HosterModel,
  config: MDConfig,
): Promise<CrawlResult | null> {
  if (item.kind !== "resolve-viewer") return null;

  const setIdMatch = /\/set\/(\d+)/.exec(item.viewerUrl);
  const setId = setIdMatch?.[1];
  if (!setId) return null;

  const res = await fetch(`/api/0.2/set/${setId}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  const parsed = parseSet(data);
  if (!parsed) return null;

  const detectedSetName = deriveGalleryName(
    parsed.site,
    parsed.model,
    parsed.name,
    parsed.postedAt,
  );
  const setSubfolder = detectedSetName ? buildSubfolder(detectedSetName, config) : "";

  const resolvedFiles: GalleryJobItem[] = [];
  for (const file of parsed.files) {
    const fullUrl = thumbnailToFull(file.thumbnailUrl);
    if (fullUrl) {
      resolvedFiles.push({
        kind: "resolved",
        imageUrl: fullUrl,
        filename: file.filename,
        subfolder: setSubfolder,
        // Preserve the viewer page URL so the Downloads tab can link back to
        // the hoster page for human verification of failed downloads.
        sourceUrl: file.viewerUrl,
      });
    } else {
      resolvedFiles.push({
        kind: "resolve-viewer",
        viewerUrl: file.viewerUrl,
        filename: file.filename,
        subfolder: setSubfolder,
      });
    }
  }

  if (resolvedFiles.length === 0) return null;

  const setJobId = crypto.randomUUID();
  return {
    req: {
      type: "MD_GALLERY_START",
      jobId: setJobId,
      hosterId: model.id,
      subfolder: setSubfolder,
      items: resolvedFiles,
      maxParallelImg: config.maxParallelImg,
      maxParallelVid: config.maxParallelVid,
      postedAt: parsed.postedAt ?? undefined,
    },
    postedAt: parsed.postedAt ?? 0,
  };
}

function sortGirlsreleasedSets(a: CrawlResult, b: CrawlResult): number {
  return compareSetsByDateAndSubfolder(
    { postedAt: a.postedAt, subfolder: a.req.subfolder },
    { postedAt: b.postedAt, subfolder: b.req.subfolder },
  );
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
    crawlConfig: {
      isCrawlItem: isGirlsreleasedSetItem,
      crawlItem: crawlGirlsreleasedSet,
      sortCrawlResults: sortGirlsreleasedSets,
      crawlConcurrency: 8,
    },
  },
  hostPermissions: [
    "https://girlsreleased.com/*",
    "https://*.girlsreleased.com/*",
    "https://*.imx.to/*",
    "https://www.imagevenue.com/*",
    "https://*.imagevenue.com/*",
  ],
  getGalleryName: async (doc: Document) => {
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

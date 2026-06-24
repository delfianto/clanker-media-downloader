import type { LeafResolver } from "./types";

export const imagevenueResolver: LeafResolver = {
  id: "imagevenue",
  matches: (url: URL) => {
    return url.hostname === "imagevenue.com" || url.hostname.endsWith(".imagevenue.com");
  },
  resolveFromViewer: async (viewerUrl: string) => {
    // ImageVenue has an interstitial on first fetch. Self-prime the cookie
    // with cache: "no-store", then fetch the real page with cache: "reload".
    await fetch(viewerUrl, { credentials: "include", cache: "no-store" });
    const res = await fetch(viewerUrl, { credentials: "include", cache: "reload" });

    if (!res.ok) {
      throw new Error(`ImageVenue HTTP ${res.status}`);
    }

    const html = await res.text();

    const imgMatch =
      html.match(
        /<img[^>]+class=["'][^"]*img-fluid[^"]*["'][^>]+src=["'](https?:\/\/[^"']+)["']/i,
      ) ||
      html.match(/<img[^>]+src=["'](https?:\/\/cdn[^"']+\.(?:jpg|jpeg|png|gif|webp)[^"']*)["']/i) ||
      html.match(/property=["']og:image["'][^>]+content=["'](https?:\/\/[^"']+)["']/i);

    if (!imgMatch?.[1]) {
      throw new Error("Failed to extract image URL from ImageVenue page");
    }

    const titleMatch = html.match(/<title>[^<]*?-\s*([^<]+)<\/title>/i);
    const filename = titleMatch?.[1]?.trim();

    return {
      url: imgMatch[1],
      ...(filename ? { filename } : {}),
    };
  },
};

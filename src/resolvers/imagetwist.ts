import type { LeafResolver } from "./types";

// imagetwist — and its imagehaha / .to / .info mirrors — is an XFileSharing host.
// The viewer page sets a cookie on first GET, then serves the full image as
// <img src="URL" class="pic"> on a credentialed re-fetch. This mirrors the
// gallery-dl and w8tcha/ripper extractors.
//
// Dead-link signature: a removed image still returns HTTP 200, but the page has
// no class="pic" image — its first <img> is a /imgs/ site asset and <title> is
// empty. We surface that as a DEAD_LINK error so the download queue treats it as
// a PERMANENT failure and skips the (pointless) retries.
export const imagetwistResolver: LeafResolver = {
  id: "imagetwist",
  matches: (url: URL) => /(?:^|\.)image(?:twist|haha)\.(?:com|to|info)$/i.test(url.hostname),
  resolveFromViewer: async (viewerUrl: string) => {
    // Prime the host cookie, then fetch the real page with it (credentials:
    // include carries the cookie the first request set).
    await fetch(viewerUrl, { credentials: "include", cache: "no-store" }).catch(() => {});
    const res = await fetch(viewerUrl, { credentials: "include", cache: "reload" });
    if (!res.ok) {
      throw new Error(`imagetwist HTTP ${res.status}`);
    }
    const html = await res.text();

    // Full image: <img ... class="pic" ...> with a direct src. Attribute order
    // varies across mirrors, so grab the whole tag, then pull src + alt out of
    // it. og:image is a fallback for markup we don't recognize.
    const picTag = html.match(/<img\b[^>]*\bclass=["']pic\b[^>]*>/i)?.[0];
    let src = picTag?.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    if (!src) {
      src = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1];
    }

    // No real image, or the only <img> is a /imgs/ site asset → the upload was
    // removed (or never existed). Permanent — do not retry.
    if (!src || src.startsWith("/imgs/")) {
      throw new Error(`DEAD_LINK: imagetwist image not found — ${viewerUrl}`);
    }

    const fullUrl = src.startsWith("//") ? `https:${src}` : src;
    const alt = picTag?.match(/\balt=["']([^"']*)["']/i)?.[1]?.trim();

    return {
      url: fullUrl,
      ...(alt ? { filename: alt } : {}),
    };
  },
};

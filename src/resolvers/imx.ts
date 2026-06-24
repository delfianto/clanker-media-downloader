import type { LeafResolver } from "./types";

export const imxResolver: LeafResolver = {
  id: "imx",
  matches: (url: URL) => {
    return url.hostname === "imx.to" || url.hostname.endsWith(".imx.to");
  },
  resolveFromViewer: async (viewerUrl: string) => {
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
      throw new Error(`DEAD_LINK: imx.to image not found — ${viewerUrl}`);
    }

    const titleMatch = html.match(/<title>(?:IMX\.to\s*\/)?\s*([^<]+)<\/title>/i);
    const filename = titleMatch?.[1]?.trim();

    return {
      url: imgMatch[1],
      ...(filename ? { filename } : {}),
    };
  },
  fromThumbnail: (thumbUrl: string) => {
    const url = new URL(thumbUrl);
    if (
      (url.hostname === "imx.to" || url.hostname.endsWith(".imx.to")) &&
      url.pathname.includes("/u/t/")
    ) {
      return thumbUrl.replace("/u/t/", "/u/i/");
    }
    return null;
  },
};

import type { LeafResolver } from "./types";
import { imxResolver } from "./imx";
import { imagevenueResolver } from "./imagevenue";
import { imagetwistResolver } from "./imagetwist";

export type { LeafResolver };

export const LEAF_RESOLVERS: LeafResolver[] = [imxResolver, imagevenueResolver, imagetwistResolver];

export async function resolveLeaf(viewerUrl: string): Promise<{ url: string; filename?: string }> {
  // Upgrade http→https before fetching. host_permissions are declared https-only,
  // and an http:// URL isn't covered by them — so the SW fetch falls back to CORS
  // mode and gets blocked ("No 'Access-Control-Allow-Origin' header"). These
  // hosts all serve https, so normalizing fixes the grant and avoids mixed
  // content. The host (used by matches/permissions) is unchanged by the scheme.
  const secureUrl = viewerUrl.replace(/^http:\/\//i, "https://");
  const u = new URL(secureUrl);
  const r = LEAF_RESOLVERS.find((r) => r.matches(u));
  if (!r) {
    // If a job was saved with a direct image URL under kind: "resolve-viewer"
    // (e.g. before a resolver matches() fix), or a hoster returned a direct
    // link, gracefully return it instead of throwing UNSUPPORTED_HOST.
    if (/\.(?:jpg|jpeg|png|gif|webp|mp4|webm)(\?|$)/i.test(u.pathname)) {
      return { url: secureUrl };
    }
    throw new Error(`no leaf resolver for host: ${u.hostname}`);
  }
  return r.resolveFromViewer(secureUrl);
}

export function thumbnailToFull(thumbUrl: string): string | null {
  try {
    const u = new URL(thumbUrl);
    for (const r of LEAF_RESOLVERS) {
      if (r.matches(u) && r.fromThumbnail) {
        const full = r.fromThumbnail(thumbUrl);
        if (full) return full;
      }
    }
  } catch {
    // Ignore invalid URLs
  }
  return null;
}

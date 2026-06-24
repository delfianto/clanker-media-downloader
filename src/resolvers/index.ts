import type { LeafResolver } from "./types";
import { imxResolver } from "./imx";
import { imagevenueResolver } from "./imagevenue";
import { imagetwistResolver } from "./imagetwist";

export type { LeafResolver };

export const LEAF_RESOLVERS: LeafResolver[] = [imxResolver, imagevenueResolver, imagetwistResolver];

export async function resolveLeaf(viewerUrl: string): Promise<{ url: string; filename?: string }> {
  const u = new URL(viewerUrl);
  const r = LEAF_RESOLVERS.find((r) => r.matches(u));
  if (!r) throw new Error(`no leaf resolver for host: ${u.hostname}`);
  return r.resolveFromViewer(viewerUrl);
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

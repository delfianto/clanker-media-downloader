export type LeafResolver = {
  id: string;
  matches: (url: URL) => boolean;
  resolveFromViewer: (viewerUrl: string) => Promise<{ url: string; filename?: string }>;
  fromThumbnail?: (thumbUrl: string) => string | null;
};

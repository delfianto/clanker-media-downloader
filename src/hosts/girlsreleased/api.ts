export type RawFile = [
  _a: unknown,
  _b: unknown,
  _c: unknown,
  viewerUrl: string,
  thumbnailUrl: string,
  originalFilename: string,
];

export type RawSet = [
  id: number,
  name: string,
  _x: unknown,
  site: string,
  files: RawFile[],
  models: [number, string][],
];

export type ParsedSet = {
  name: string;
  site: string;
  model: string;
  files: { viewerUrl: string; thumbnailUrl: string; filename: string }[];
};

export function parseSet(json: unknown): ParsedSet | null {
  if (!json || typeof json !== "object") return null;
  const data = json as { set?: unknown };
  const setArray = data.set;
  if (!Array.isArray(setArray) || setArray.length < 6) {
    return null;
  }

  const name = String(setArray[1] || "");
  const site = String(setArray[3] || "");
  const filesArray = setArray[4];
  const models = setArray[5];

  const model =
    Array.isArray(models) && models[0] && Array.isArray(models[0]) && models[0][1]
      ? String(models[0][1])
      : "";

  if (!Array.isArray(filesArray)) {
    return null;
  }

  const files: { viewerUrl: string; thumbnailUrl: string; filename: string }[] = [];
  for (const file of filesArray) {
    if (!Array.isArray(file) || file.length < 6) {
      continue;
    }
    const viewerUrl = String(file[3] || "");
    const thumbnailUrl = String(file[4] || "");
    const originalFilename = String(file[5] || "");

    if (!viewerUrl && !thumbnailUrl) {
      continue;
    }

    const filename = originalFilename || viewerUrl.split("/").at(-1) || "file";
    files.push({
      viewerUrl,
      thumbnailUrl,
      filename,
    });
  }

  return {
    name,
    site,
    model,
    files,
  };
}

export function deriveGalleryName(site: string, model: string, name: string): string {
  let cleanSite = site.replace(/\.[a-z]{2,6}$/i, "");
  if (cleanSite) {
    cleanSite = cleanSite.charAt(0).toUpperCase() + cleanSite.slice(1);
  }

  const cleanSetName = name.replace(/\s*\/\s*/g, " - ");

  if (cleanSite) {
    if (model) {
      return `${cleanSite}/${model} - ${cleanSetName}`;
    } else {
      return `${cleanSite}/${cleanSetName}`;
    }
  }
  return cleanSetName;
}

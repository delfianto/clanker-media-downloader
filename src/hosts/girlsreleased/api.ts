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
  date: unknown, // unix seconds — when the set was posted to girlsreleased
  site: string,
  files: RawFile[],
  models: [number, string][],
];

export type ParsedSet = {
  name: string;
  site: string;
  model: string;
  postedAt: number | null; // unix seconds; null when absent or implausible
  files: { viewerUrl: string; thumbnailUrl: string; filename: string }[];
};

export function parseSet(json: unknown): ParsedSet | null {
  if (!json || typeof json !== "object") return null;
  const data = json as { set?: unknown };
  const setVal = data.set;
  if (!setVal || typeof setVal !== "object") return null;

  let name = "";
  let site = "";
  let model = "";
  let postedAt: number | null = null;
  let filesArray: unknown = null;

  if (Array.isArray(setVal)) {
    // Version 0.3 (array format)
    if (setVal.length < 5) return null;
    name = String(setVal[1] || "");
    postedAt = parsePostedAt(setVal[2]);
    site = String(setVal[3] || "");
    filesArray = setVal[4];
    const models = setVal[5];
    model =
      Array.isArray(models) && models[0] && Array.isArray(models[0]) && models[0][1]
        ? String(models[0][1])
        : "";
  } else {
    // Version 0.2 (object format)
    const setObj = setVal as Record<string, unknown>;
    name = String(setObj["name"] || "");
    site = String(setObj["site"] || "");
    postedAt = parsePostedAt(setObj["date"]);
    filesArray = setObj["images"];
    const models = setObj["models"];
    model =
      Array.isArray(models) && models[0] && Array.isArray(models[0]) && models[0][1]
        ? String(models[0][1])
        : "";
  }

  if (!Array.isArray(filesArray)) {
    return null;
  }

  const files: { viewerUrl: string; thumbnailUrl: string; filename: string }[] = [];
  for (const file of filesArray) {
    if (!Array.isArray(file)) continue;

    // Need viewerUrl (3) + thumbnailUrl (4); originalFilename (5) is optional
    // (filename falls back to the viewer-URL slug below).
    if (file.length < 5) {
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
    postedAt,
    files,
  };
}

// girlsreleased exposes a unix-seconds timestamp at set index 2 — the date the
// set was *posted* to the board (NOT the studio's original release date; see
// REFACTOR.md §11). Returns seconds, or null if absent / implausible. Tolerates
// millisecond values defensively.
function parsePostedAt(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return null;
  const secs = n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
  // Plausible window: 2000-01-01 .. now + 1 day. Anything else isn't a date.
  if (secs < 946684800 || secs > Math.floor(Date.now() / 1000) + 86400) return null;
  return secs;
}

// "YYYY.MM.DD" in UTC (deterministic regardless of the user's timezone),
// or "" when there is no usable timestamp.
function formatPostedDate(postedAt: number | null): string {
  if (postedAt === null) return "";
  const d = new Date(postedAt * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}`;
}

function cleanSegment(s: string): string {
  return s
    .trim()
    .replace(/[/\\]+/g, " - ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-.]+|[\s\-.]+$/g, "");
}

// Build the per-set folder path: "Studio/Date - Model - Gallery Name"
// Timestamp and model are omitted when unavailable, e.g. "Studio/Gallery Name".
export function deriveGalleryName(
  site: string,
  model: string,
  name: string,
  postedAt: number | null = null,
): string {
  let studio = site.replace(/\.[a-z]{2,6}$/i, "");
  if (studio) {
    studio = studio.charAt(0).toUpperCase() + studio.slice(1);
  }

  // Clean up gallery name: strip model name and site name if they are present in the name
  let galleryName = name;
  if (model) {
    const escapedModel = model.trim().replace(/[.+?^${}()|[\\]\\\\]/g, "\\$&");
    const rxModel = new RegExp(`^${escapedModel}\\s*-\\s*|\\s*-\\s*${escapedModel}`, "i");
    galleryName = galleryName.replace(rxModel, "");
  }
  if (site) {
    const escapedSite = site.trim().replace(/[.+?^${}()|[\\]\\\\]/g, "\\$&");
    const rxSite = new RegExp(`^${escapedSite}\\s*-\\s*|\\s*-\\s*${escapedSite}`, "i");
    galleryName = galleryName.replace(rxSite, "");
  }

  const cleanedModel = cleanSegment(model);
  const cleanedGallery = cleanSegment(galleryName);
  const datePart = formatPostedDate(postedAt);

  // We keep clean names with normal spaces (no dotify) but strip invalid chars
  const segment = [datePart, cleanedModel, cleanedGallery].filter(Boolean).join(" - ");

  return studio ? `${studio}/${segment}` : segment;
}

export function compareSetsByDateAndSubfolder(
  a: { postedAt?: number | null; subfolder: string },
  b: { postedAt?: number | null; subfolder: string },
): number {
  const getPostedDateString = (postedAt?: number | null): string => {
    if (!postedAt) return "";
    const d = new Date(postedAt * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}`;
  };

  const dateA = getPostedDateString(a.postedAt);
  const dateB = getPostedDateString(b.postedAt);
  if (dateA !== dateB) {
    return dateB.localeCompare(dateA); // descending
  }
  return a.subfolder.localeCompare(b.subfolder); // alphabetical ascending
}

// Filename sanitization for browser.downloads.download(). Chrome/Firefox
// pass the filename to the OS, so we sanitize for the most restrictive
// platform (Windows): \ / : * ? " < > | and control chars (0x00-0x1F).
// Also trims leading/trailing spaces and dots (Windows rejects those).

const ILLEGAL_CHARS = new RegExp('[/\\\\:*?"<>|]', "g");
// eslint-disable-next-line no-control-regex -- intentionally strip control chars (0x00-0x1F) from filenames
const CONTROL_CHARS = /[\u0000-\u001f]/g;

export function sanitizeFilename(name: string): string {
  let clean = name.replace(ILLEGAL_CHARS, "_").replace(CONTROL_CHARS, "");
  // Collapse consecutive underscores from multiple illegal chars
  clean = clean.replace(/_+/g, "_");
  // Windows forbids leading/trailing spaces, dots, hyphens, and underscores
  clean = clean.replace(/^[\s._-]+|[\s._-]+$/g, "");

  // Truncate to prevent MAX_PATH overflow which causes Chrome to drop the
  // subfolder and dump the file into ~/Downloads. Keep it to 100 chars.
  if (clean.length > 100) {
    const extIdx = clean.lastIndexOf(".");
    if (extIdx !== -1 && clean.length - extIdx <= 10) {
      // Preserve extension (up to 10 chars)
      clean = clean.slice(0, 100 - (clean.length - extIdx)) + clean.slice(extIdx);
    } else {
      clean = clean.slice(0, 100);
    }
    // Re-trim trailing dots/spaces that might have been exposed by truncation
    clean = clean.replace(/[\s._-]+$/g, "");
  }

  // Don't let sanitization produce an empty name
  return clean || "file";
}

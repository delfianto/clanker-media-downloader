// Media file extension detection — shared between gallery SW and tests.
// Video/audio files get separate (lower) parallelism because CDNs throttle
// large parallel downloads.

const MEDIA_EXTS = new Set([
  "mp4",
  "mov",
  "mkv",
  "webm",
  "avi",
  "m4v",
  "wmv",
  "flv",
  "mpg",
  "mpeg",
  "ts",
  "3gp",
  "mp3",
  "wav",
  "flac",
  "aac",
  "ogg",
  "m4a",
  "opus",
  "wma",
]);

export function isMediaFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext ? MEDIA_EXTS.has(ext) : false;
}

// ── Failure classification ───────────────────────────────────────────────────
// Every download/resolve failure is one of two kinds:
//   permanent — the file or host won't recover by retrying (removed, 403/404,
//               disk full, unsupported host). Retrying just wastes time/backoff.
//   ephemeral — a transient server/network blip; a retry may succeed.
// Covers both browser.downloads interruption codes and fetch-stage errors.

// Permanent — never retry. Includes our resolvers' DEAD_LINK sentinel.
const PERMANENT_ERRORS = [
  "DEAD_LINK", // resolver detected a removed/non-existent upload
  "SERVER_BAD_CONTENT", // HTTP 404/410 — file gone
  "SERVER_FORBIDDEN", // 403
  "SERVER_UNAUTHORIZED", // 401
  "SERVER_CERT_PROBLEM",
  "FILE_NO_SPACE",
  "FILE_ACCESS_DENIED",
  "FILE_NAME_TOO_LONG",
  "no leaf resolver", // unsupported host — won't change on retry
];

// Ephemeral — a retry might succeed.
const EPHEMERAL_ERRORS = [
  "SERVER_FAILED",
  "SERVER_UNREACHABLE",
  "SERVER_NO_RANGE",
  "SERVER_CONTENT_LENGTH_MISMATCH",
  "NETWORK_FAILED",
  "NETWORK_TIMEOUT",
  "NETWORK_DISCONNECTED",
  "NETWORK_SERVER_DOWN",
  "FILE_TRANSIENT_ERROR",
  "CRASH",
];

// Fetch-stage transients (resolveFromViewer, viewer-page GET).
const EPHEMERAL_PATTERNS = /Failed to fetch|NetworkError|\babort/i;

export type FailureKind = "ephemeral" | "permanent";

export function classifyFailure(err: unknown): FailureKind {
  const msg = String(err);
  if (PERMANENT_ERRORS.some((e) => msg.includes(e))) return "permanent";
  if (EPHEMERAL_ERRORS.some((e) => msg.includes(e))) return "ephemeral";
  if (EPHEMERAL_PATTERNS.test(msg) || /HTTP\s+(?:5\d\d|429)/.test(msg)) return "ephemeral";
  // Unknown → permanent: don't burn 5 retries + exponential backoff on
  // something we can't confirm is transient. Real transients have known codes.
  return "permanent";
}

export function isTransientError(err: unknown): boolean {
  return classifyFailure(err) === "ephemeral";
}

// Short, user-facing label for an item's failure. The raw error (download
// interrupt codes, HTML snippets, JSON) goes to the logs; the History UI shows
// just this code so a failed row reads "IMAGE_NOT_FOUND" instead of a wall of text.
export function failureLabel(err: unknown): string {
  const msg = String(err);
  if (
    /DEAD_LINK|SERVER_BAD_CONTENT|not found|no match|Failed to (?:parse|extract)|extraction failed/i.test(
      msg,
    )
  ) {
    return "IMAGE_NOT_FOUND";
  }
  if (/SERVER_FORBIDDEN|SERVER_UNAUTHORIZED|HTTP\s+40[13]/i.test(msg)) return "ACCESS_DENIED";
  if (/no leaf resolver/i.test(msg)) return "UNSUPPORTED_HOST";
  if (/FILE_NO_SPACE/i.test(msg)) return "DISK_FULL";
  if (classifyFailure(err) === "ephemeral") return "TEMPORARY_ERROR";
  return "ERROR";
}

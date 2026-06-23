const ALLOWED = new Set(["http:", "https:"]);

// runtime.sendMessage can't carry an ArrayBuffer under Chrome's default JSON
// serialisation, so the bytes are shipped to the content script as base64.
// Encode in chunks to stay well under the argument-count limit of fromCharCode.
function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000; // 32 KiB
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Fetch a URL as plain text — used by the gallery runner to scrape viewer page
// HTML for image URL extraction without executing the page's own JS.
export async function crossOriginFetchText(url: string): Promise<{ text: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (!ALLOWED.has(parsed.protocol)) {
    throw new Error(`Blocked protocol: ${parsed.protocol}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      credentials: "include",
      cache: "default",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

// Runs in the service worker, which has host_permissions and so bypasses page
// CORS. credentials:include sends session cookies to CDN; cache:default uses
// normal HTTP caching behaviour.
export async function crossOriginFetchBlob(
  url: string,
): Promise<{ base64: string; contentType: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (!ALLOWED.has(parsed.protocol)) {
    throw new Error(`Blocked protocol: ${parsed.protocol}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      credentials: "include",
      cache: "default",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    return { base64: bufferToBase64(buffer), contentType };
  } finally {
    clearTimeout(timer);
  }
}

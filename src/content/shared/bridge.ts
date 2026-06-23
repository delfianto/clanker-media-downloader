import type { MDBlobResult, MDMainRequest, MDMainResponse } from "../../types/messages";

// MAIN-world side of the fetch bridge. The MAIN world has no browser.* API, so
// it asks the ISOLATED world (via window.postMessage) to run the SW fetch and
// hand back the decoded bytes. Responses are correlated by a random id.
const pending = new Map<string, (result: MDBlobResult) => void>();

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as Partial<MDMainResponse>;
  if (data.type !== "MD_RESPONSE" || typeof data.id !== "string" || !data.result) return;

  const resolve = pending.get(data.id);
  if (!resolve) return;
  pending.delete(data.id);
  resolve(data.result);
});

export function request(url: string, timeoutMs = 45_000): Promise<MDBlobResult> {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ error: "Timed out waiting for the download" });
    }, timeoutMs);

    pending.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });

    const message: MDMainRequest = { type: "MD_REQUEST", id, url };
    window.postMessage(message, "*");
  });
}

export function requestDownloadSingle(
  url: string,
  filename: string,
  subfolder: string,
  timeoutMs = 45_000,
): Promise<MDBlobResult> {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ error: "Timed out waiting for the download" });
    }, timeoutMs);

    pending.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });

    const message = { type: "MD_DOWNLOAD_SINGLE" as const, id, url, filename, subfolder };
    window.postMessage(message, "*");
  });
}

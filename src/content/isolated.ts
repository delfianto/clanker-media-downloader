import browser from "webextension-polyfill";
import type { MDConfig, Settings } from "../types/global";
import type { HosterModel } from "../types/hoster";
import type {
  MDBlobResult,
  MDFetchBlobRequest,
  MDFetchBlobResponse,
  MDGalleryStartRequest,
  MDMainRequest,
  MDMainResponse,
} from "../types/messages";
import { ALL_MODELS } from "../hosts/index";
import { DEFAULT_SETTINGS } from "../settings/schema";

// ISOLATED world, document_idle, on viewer + gallery pages. Responsibilities:
//   1. resolve which hoster this page belongs to + whether it's viewer or gallery,
//   2. inject the user's CSS overrides (viewer pages only),
//   3. hand the matched hoster id + pageType + gallery settings to MAIN world,
//   4. relay MAIN's single-image fetch requests to the SW and post bytes back,
//   5. relay MAIN's gallery start requests to the SW (fire-and-forget).

// MV3 match pattern → anchored RegExp.
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

type PageMatch = { model: HosterModel; pageType: "viewer" | "gallery" };

function matchPage(href: string, pathname: string): PageMatch | undefined {
  for (const model of ALL_MODELS) {
    const gc = model.galleryConfig;

    // Check gallery matches first.
    if (gc?.galleryMatches.some((p) => patternToRegex(p).test(href))) {
      if (gc.viewerIndicator) {
        // imagebam: viewer and gallery share /view/*. If the viewerIndicator
        // element IS present we're on a single-image viewer; fall through.
        if (!document.querySelector(gc.viewerIndicator)) {
          return { model, pageType: "gallery" };
        }
      } else {
        return { model, pageType: "gallery" };
      }
    }

    // Viewer match.
    if (model.viewerMatches.some((p) => patternToRegex(p).test(href))) {
      const guard = model.downloadConfig.pathGuard;
      if (!guard || new RegExp(guard).test(pathname)) {
        return { model, pageType: "viewer" };
      }
    }
  }
  return undefined;
}

function injectCss(css: string): void {
  const style = document.createElement("style");
  style.textContent = css;
  (document.head ?? document.documentElement).appendChild(style);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function onMainMessage(event: MessageEvent): void {
  if (event.source !== window) return;
  const data = event.data as Record<string, unknown>;
  const type = data["type"];

  if (type === "MD_REQUEST") {
    const req = data as unknown as MDMainRequest;
    if (typeof req.id === "string" && typeof req.url === "string") {
      void relayBlob(req.id, req.url);
    }
    return;
  }

  if (type === "MD_GALLERY_START") {
    // Fire-and-forget: no response needed in MAIN world; SW handles progress.
    void browser.runtime.sendMessage(data as unknown as MDGalleryStartRequest).catch(() => {});
  }
}

async function relayBlob(id: string, url: string): Promise<void> {
  let result: MDBlobResult;
  try {
    const request: MDFetchBlobRequest = { type: "MD_FETCH_BLOB", url };
    const res = (await browser.runtime.sendMessage(request)) as MDFetchBlobResponse;
    result =
      "error" in res
        ? { error: res.error }
        : { buffer: base64ToBuffer(res.base64), contentType: res.contentType };
  } catch (e) {
    result = { error: e instanceof Error ? e.message : String(e) };
  }

  const response: MDMainResponse = { type: "MD_RESPONSE", id, result };
  if ("buffer" in result) {
    window.postMessage(response, "*", [result.buffer]);
  } else {
    window.postMessage(response, "*");
  }
}

async function init(): Promise<void> {
  let settings: Settings;
  try {
    settings = (await browser.storage.local.get(DEFAULT_SETTINGS)) as Settings;
  } catch {
    settings = DEFAULT_SETTINGS;
  }
  if (!settings.enabled) return;

  const match = matchPage(location.href, location.pathname);
  if (!match) return;

  const { model, pageType } = match;
  const override = settings.hosters[model.id];
  if (!override?.enabled) return;

  if (model.id === "imagebam") {
    if (!document.cookie.includes("nsfw_inter=1")) {
      document.cookie = "nsfw_inter=1; path=/; max-age=21600";
    }
  }

  if (pageType === "viewer" && override.cssOverrides) injectCss(override.cssOverrides);

  window.addEventListener("message", onMainMessage);

  const config: MDConfig = {
    hosterId: model.id,
    pageType,
    maxParallel: settings.maxParallel,
    subfolderPrefix: settings.subfolderPrefix,
    autoFolderPerAlbum: settings.autoFolderPerAlbum,
  };
  document.dispatchEvent(new CustomEvent("__md_config__", { detail: JSON.stringify(config) }));
}

void init().catch(() => {});

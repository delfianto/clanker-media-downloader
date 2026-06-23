import browser from "webextension-polyfill";
import type { Settings } from "../types/global";
import type { HosterModel } from "../types/hoster";
import { ALL_MODELS } from "../hosts/index";
import { DEFAULT_SETTINGS } from "../settings/schema";

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchModel(url: string): HosterModel | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }
  return ALL_MODELS.find((model) => {
    const isViewer = model.viewerMatches.some((p) => patternToRegex(p).test(url));
    const isGallery =
      model.galleryConfig?.galleryMatches.some((p) => patternToRegex(p).test(url)) ?? false;

    if (!isViewer && !isGallery) return false;

    // If it matched as a viewer, check the pathGuard
    if (isViewer && !isGallery) {
      const guard = model.downloadConfig.pathGuard;
      if (guard && !new RegExp(guard).test(pathname)) {
        return false;
      }
    }

    return true;
  });
}

async function init(): Promise<void> {
  let settings: Settings;
  try {
    settings = (await browser.storage.local.get(DEFAULT_SETTINGS)) as Settings;
  } catch {
    settings = DEFAULT_SETTINGS;
  }

  $<HTMLSpanElement>("version").textContent = `v${browser.runtime.getManifest().version}`;

  const enabled = $<HTMLInputElement>("enabled");
  enabled.checked = settings.enabled;
  enabled.addEventListener("change", () => {
    void browser.storage.local.set({ enabled: enabled.checked });
  });

  // Active-page detection. tabs.query returns tab.url for pages that match our
  // host_permissions even without the "tabs" permission — exactly the hoster
  // pages we care about; everything else comes back without a url.
  const dot = $("active-dot");
  const text = $("active-text");
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const model = tab?.url ? matchModel(tab.url) : undefined;
    if (!model) {
      dot.className = "dot";
      text.textContent = "None";
    } else if (settings.enabled && settings.hosters[model.id].enabled) {
      dot.className = "dot on";
      text.textContent = model.displayName;
    } else {
      dot.className = "dot";
      text.textContent = model.displayName;
    }
  } catch {
    dot.className = "dot";
    text.textContent = "Unavailable";
  }

  $("open-options").addEventListener("click", () => {
    void browser.runtime.openOptionsPage();
    window.close();
  });
}

void init();

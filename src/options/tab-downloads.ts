import type { Settings } from "../types/global";
import { DEFAULT_SETTINGS } from "../settings/schema";
import { $, el, toast } from "./dom";

export function renderDownloadsSettings(
  settings: Settings,
  persist: () => void,
  persistSoon: () => void,
): void {
  const container = $("dl-settings");
  container.replaceChildren();

  // Max parallel (images)
  const parallelInput = el("input", {
    type: "number",
    className: "narrow",
    value: String(settings.maxParallelImg),
    min: "1",
    max: "20",
  } as Partial<HTMLInputElement>);
  parallelInput.addEventListener("change", () => {
    const v = Math.min(20, Math.max(1, Number(parallelInput.value) || 5));
    parallelInput.value = String(v);
    settings.maxParallelImg = v;
    persistSoon();
  });

  // Max parallel (videos)
  const parallelVideoInput = el("input", {
    type: "number",
    className: "narrow",
    value: String(settings.maxParallelVid),
    min: "1",
    max: "5",
  } as Partial<HTMLInputElement>);
  parallelVideoInput.addEventListener("change", () => {
    const v = Math.min(5, Math.max(1, Number(parallelVideoInput.value) || 1));
    parallelVideoInput.value = String(v);
    settings.maxParallelVid = v;
    persistSoon();
  });

  // Max download retries
  const retriesInput = el("input", {
    type: "number",
    className: "narrow",
    value: String(settings.maxDownloadRetries),
    min: "0",
    max: "10",
  } as Partial<HTMLInputElement>);
  retriesInput.addEventListener("change", () => {
    const v = Math.min(10, Math.max(0, Number(retriesInput.value) || 0));
    retriesInput.value = String(v);
    settings.maxDownloadRetries = v;
    persistSoon();
  });

  // Auto-folder toggle
  const autoFolderToggle = el("input", {
    type: "checkbox",
    checked: settings.autoFolderPerAlbum,
  });
  autoFolderToggle.addEventListener("change", () => {
    settings.autoFolderPerAlbum = autoFolderToggle.checked;
    persist();
  });

  // Download directory
  const dirInput = el("input", {
    type: "text",
    value: settings.downloadDirectory,
    placeholder: "e.g. Clanker",
  });
  dirInput.addEventListener("input", () => {
    settings.downloadDirectory = dirInput.value;
    persistSoon();
  });

  // Verbose logging toggle
  const verboseToggle = el("input", { type: "checkbox", checked: settings.verboseLogging });
  verboseToggle.addEventListener("change", () => {
    settings.verboseLogging = verboseToggle.checked;
    persist();
  });

  // Skip existing files toggle
  const skipExistingToggle = el("input", {
    type: "checkbox",
    checked: settings.skipExistingFiles,
  });
  skipExistingToggle.addEventListener("change", () => {
    settings.skipExistingFiles = skipExistingToggle.checked;
    persist();
  });

  const resetBtn = el("button", {
    className: "reset-btn",
    textContent: "↺ Reset Settings",
  });
  resetBtn.style.marginTop = "20px";
  resetBtn.style.display = "block";
  resetBtn.addEventListener("click", () => {
    if (!confirm("Reset all download settings to defaults?")) return;
    settings.maxParallelImg = DEFAULT_SETTINGS.maxParallelImg;
    settings.maxParallelVid = DEFAULT_SETTINGS.maxParallelVid;
    settings.maxDownloadRetries = DEFAULT_SETTINGS.maxDownloadRetries;
    settings.downloadDirectory = DEFAULT_SETTINGS.downloadDirectory;
    settings.autoFolderPerAlbum = DEFAULT_SETTINGS.autoFolderPerAlbum;
    settings.verboseLogging = DEFAULT_SETTINGS.verboseLogging;
    settings.skipExistingFiles = DEFAULT_SETTINGS.skipExistingFiles;
    persist();
    renderDownloadsSettings(settings, persist, persistSoon);
    toast("Settings reset to defaults");
  });

  container.append(
    el("div", { className: "settings-field" }, [
      el("div", {}, [
        el("div", { className: "settings-label", textContent: "Max parallel — images" }),
        el("div", { className: "settings-hint", textContent: "1–20 image files at a time" }),
      ]),
      parallelInput,
    ]),
    el("div", { className: "settings-field" }, [
      el("div", {}, [
        el("div", { className: "settings-label", textContent: "Max parallel — videos" }),
        el("div", {
          className: "settings-hint",
          textContent: "1–5 video/audio files at a time (CDNs throttle large files)",
        }),
      ]),
      parallelVideoInput,
    ]),
    el("div", { className: "settings-field" }, [
      el("div", {}, [
        el("div", { className: "settings-label", textContent: "Max download retries" }),
        el("div", {
          className: "settings-hint",
          textContent: "0–10 retry attempts for transient errors (SERVER_FAILED, NETWORK_FAILED)",
        }),
      ]),
      retriesInput,
    ]),
    el("div", { className: "settings-field" }, [
      el("div", {}, [
        el("div", { className: "settings-label", textContent: "Download directory" }),
        el("div", {
          className: "settings-hint",
          textContent: "Relative path inside your browser's default downloads folder",
        }),
      ]),
      dirInput,
    ]),
    el("div", { className: "settings-field" }, [
      el("div", {}, [
        el("div", { className: "settings-label", textContent: "Create subfolder by album name" }),
        el("div", {
          className: "settings-hint",
          textContent: "Creates a subfolder for each album/gallery inside the download directory",
        }),
      ]),
      el("label", { className: "hoster-toggle" }, [
        el("span", { className: "switch" }, [
          autoFolderToggle,
          el("span", { className: "slider" }),
        ]),
      ]),
    ]),
    el("div", { className: "settings-field" }, [
      el("div", {}, [
        el("div", { className: "settings-label", textContent: "Verbose logging" }),
        el("div", {
          className: "settings-hint",
          textContent: "Emit debug-level detail to the Logs tab",
        }),
      ]),
      el("label", { className: "hoster-toggle" }, [
        el("span", { className: "switch" }, [verboseToggle, el("span", { className: "slider" })]),
      ]),
    ]),
    el("div", { className: "settings-field" }, [
      el("div", {}, [
        el("div", { className: "settings-label", textContent: "Skip already downloaded files" }),
        el("div", {
          className: "settings-hint",
          textContent:
            "Skip files that already exist in download history (same folder + name) — O(1) IDB lookup, persists across restarts",
        }),
      ]),
      el("label", { className: "hoster-toggle" }, [
        el("span", { className: "switch" }, [
          skipExistingToggle,
          el("span", { className: "slider" }),
        ]),
      ]),
    ]),
    resetBtn,
  );
}

import browser from "webextension-polyfill";

// Chrome re-renders its download shelf/bubble on the BROWSER UI thread for every
// downloads.download() call. A crawl fires thousands of them, so the whole
// browser janks. We suppress the native download UI — but only while download
// jobs are actually running (ref-counted) and restore it when idle, so ordinary
// manual downloads keep their shelf. While jobs run we surface progress on the
// toolbar icon instead (badge = number of active download jobs).
//
// setUiOptions is Chrome-only and gated behind the "downloads.ui" permission;
// browser.action badges work on both. Both are feature-detected so Firefox just
// no-ops the parts it lacks.

const dl = browser.downloads as unknown as {
  setUiOptions?: (opts: { enabled: boolean }) => Promise<void>;
};

let activeJobs = 0;
let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

function setNativeUi(enabled: boolean): void {
  if (typeof dl.setUiOptions !== "function") return;
  dl.setUiOptions({ enabled }).catch((err: unknown) => {
    console.warn(`[md] downloads.setUiOptions(${enabled}) failed:`, err);
  });
}

function updateBadge(): void {
  // A small green dot while downloads are active — clearer at a glance than a
  // tiny job count (the popup has the actual numbers). It's a "●" glyph in green
  // over a transparent badge background, so it reads as a status dot on the icon
  // rather than a colored chip. setBadgeTextColor is Chrome 110+/Firefox; cast
  // since webextension-polyfill's types may not include it. Firefox no-ops the
  // bits it lacks.
  const action = browser.action as unknown as {
    setBadgeTextColor?: (details: { color: string }) => Promise<void>;
  };
  if (activeJobs > 0) {
    void browser.action.setBadgeText({ text: "●" }).catch(() => {});
    void action.setBadgeTextColor?.({ color: "#22c55e" }).catch(() => {});
    // Transparent background so only the green dot shows over the icon.
    void browser.action.setBadgeBackgroundColor({ color: [0, 0, 0, 0] }).catch(() => {});
  } else {
    void browser.action.setBadgeText({ text: "" }).catch(() => {});
  }
}

// SW startup: no job is active yet (resumeRunningJobs marks any leftover running
// jobs as error), so force the native UI back on. This recovers the case where
// the SW died mid-crawl while the UI was suppressed and never got to restore it.
export function initDownloadUi(): void {
  activeJobs = 0;
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
  }
  setNativeUi(true);
  updateBadge();
}

// A download job started running — suppress the native UI on the 0→1 edge.
export function jobActivityBegin(): void {
  activeJobs++;
  if (activeJobs === 1) {
    setNativeUi(false);
    // MV3 SW idle timer is 30s. Ping an extension API every 20s to prevent
    // Chrome from killing the SW while jobs are running but no new browser
    // API calls have been made recently.
    keepAliveTimer = setInterval(() => {
      browser.runtime.getPlatformInfo().catch(() => {});
    }, 20000);
  }
  updateBadge();
}

// A download job reached a terminal state — restore the native UI on the 1→0
// edge. Safe to over-call; clamped at zero.
export function jobActivityEnd(): void {
  if (activeJobs > 0) activeJobs--;
  if (activeJobs === 0) {
    setNativeUi(true);
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = undefined;
    }
  }
  updateBadge();
}

import { defineConfig, type PluginOption } from "vite-plus";
import webExtension from "vite-plugin-web-extension";
import { ALL_MODELS } from "./src/hosts/index";

type Browser = "chrome" | "firefox";

const browser = (process.env["BROWSER"] ?? "chrome") as Browser;

// Derive content-script matches from the models — the model is the single
// source of truth for which pages each hoster runs on. Adding a new hoster
// no longer requires editing this file (just add to ALL_MODELS). Deduplicated
// because some hosters (imagebam) share URL patterns between viewer + gallery.
const CONTENT_MATCHES = Array.from(
  new Set(
    ALL_MODELS.flatMap((m) => {
      const matches = [...m.viewerMatches];
      if (m.galleryConfig) matches.push(...m.galleryConfig.galleryMatches);
      return matches;
    }),
  ),
);

// CDN domains — where the redirector intercepts raw image URLs at document_start.
const CDN_MATCHES = Array.from(new Set(ALL_MODELS.flatMap((m) => m.cdnMatches)));

// Host permissions derived from models — each model declares what the SW needs
// beyond content-script matches (CDN fetches, sign APIs, resolvers, etc.).
const HOST_PERMISSIONS = Array.from(new Set(ALL_MODELS.flatMap((m) => m.hostPermissions ?? [])));

function makeManifest(target: Browser): Record<string, unknown> {
  const base: Record<string, unknown> = {
    manifest_version: 3,
    name: "Clanker Media Downloader",
    version: "1.0.0",
    description:
      "One-click image downloads from image hosting sites. Clean, private, no external server.",
    icons: { "48": "icons/icon-48.png", "96": "icons/icon-96.png" },
    permissions: ["storage", "downloads", "declarativeNetRequest", "offscreen", "unlimitedStorage"],
    host_permissions: HOST_PERMISSIONS,
    background: { service_worker: "src/background/index.ts", type: "module" },
    action: {
      default_popup: "src/popup/index.html",
      default_icon: { "48": "icons/icon-48.png", "96": "icons/icon-96.png" },
    },
    options_ui: {
      page: "src/options/index.html",
      open_in_tab: true,
    },
    content_scripts: [
      // Redirector — CDN domains, document_start, ISOLATED (needs browser.storage).
      {
        matches: [...CDN_MATCHES],
        js: ["src/content/redirector.ts"],
        run_at: "document_start",
        all_frames: false,
        world: "ISOLATED",
      },
      // Viewer pages — ISOLATED: config bridge + CSS injection + SW fetch relay.
      {
        matches: [...CONTENT_MATCHES],
        js: ["src/content/isolated.ts"],
        run_at: "document_idle",
        all_frames: false,
        world: "ISOLATED",
      },
      // Viewer pages — MAIN: DOM adapter (button injection + download trigger).
      {
        matches: [...CONTENT_MATCHES],
        js: ["src/content/main.ts"],
        run_at: "document_idle",
        all_frames: false,
        world: "MAIN",
      },
    ],
  };

  if (target === "firefox") {
    base["browser_specific_settings"] = {
      gecko: {
        id: "clanker-media-downloader@delfianto",
        strict_min_version: "128.0",
      },
    };
  }

  return base;
}

export default defineConfig({
  build: {
    outDir: `build/${browser}`,
    emptyOutDir: true,
    sourcemap: process.env["NODE_ENV"] !== "production",
    // true uses the toolchain's native Oxc minifier; "esbuild" is dead in Vite+.
    minify: process.env["NODE_ENV"] === "production",
  },

  lint: {
    ignorePatterns: ["build/**", "node_modules/**"],
    rules: {
      "no-console": "off",
      "unicorn/no-thenable": "error",
    },
  },

  fmt: {
    // Prose docs (CLAUDE.md, README.md) are hand-maintained — don't auto-reflow them.
    ignorePatterns: ["build/**", "node_modules/**", "**/*.md"],
  },

  // vite-plugin-web-extension is typed against a different copy of vite than
  // vite-plus bundles, so its PluginOption is nominally (not structurally)
  // incompatible. Cast across the boundary to avoid the recursive-type compare
  // (TS2321 excessive stack depth / TS2769 overload mismatch).
  plugins: [
    webExtension({
      browser,
      manifest: () => makeManifest(browser),
      additionalInputs: ["src/offscreen/index.html"],
    }),
  ] as unknown as PluginOption[],
});

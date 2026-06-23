import { defineConfig } from "vite-plus";
import webExtension from "vite-plugin-web-extension";
import { BUNKR_DOMAINS } from "./src/hosts/bunkr/model";

type Browser = "chrome" | "firefox";

const browser = (process.env["BROWSER"] ?? "chrome") as Browser;

// All pages where content scripts are injected — both viewer and gallery pages.
// isolated.ts + main.ts dispatch based on pageType at runtime.
const CONTENT_MATCHES = [
  // Viewer pages
  "https://www.imagebam.com/image/*",
  "https://www.imagebam.com/view/*", // also covers gallery pages (distinguished by DOM)
  "https://www.imagebam.com/gallery/*", // legacy gallery pages
  "https://imgbox.com/*",
  "https://ibb.co/*",
  ...BUNKR_DOMAINS.map((d) => `https://${d}/f/*`),
  // Gallery pages
  "https://imgbox.com/g/*",
  "https://ibb.co/album/*",
  ...BUNKR_DOMAINS.map((d) => `https://${d}/a/*`),
  "https://*.erome.com/a/*",
  "https://jpg6.su/album/*",
  "https://jpg6.su/*",
  "https://girlsreleased.com/*",
  "https://*.girlsreleased.com/*",
] as const;

// CDN domains — where the redirector intercepts raw image URLs at document_start.
// imgbb has no CDN redirect (its thumbnails link straight to the ibb.co viewer).
const CDN_MATCHES = ["https://*.imagebam.com/*", "https://*.imgbox.com/*"] as const;

function makeManifest(target: Browser): Record<string, unknown> {
  const base: Record<string, unknown> = {
    manifest_version: 3,
    name: "Clanker Media Downloader",
    version: "1.0.0",
    description:
      "One-click image downloads from image hosting sites. Clean, private, no external server.",
    icons: { "48": "icons/icon-48.png", "96": "icons/icon-96.png" },
    permissions: ["storage", "downloads", "declarativeNetRequest", "offscreen"],
    host_permissions: [
      "https://*.imagebam.com/*",
      "https://imgbox.com/*",
      "https://*.imgbox.com/*",
      "https://ibb.co/*",
      "https://*.ibb.co/*",
      "https://*.imgbb.com/*",
      "https://*.cdn.cr/*",
      // bunkr — needed for SW to fetch album/viewer pages for gallery resolution
      ...BUNKR_DOMAINS.map((d) => `https://${d}/*`),
      "https://*.erome.com/*",
      "https://jpg6.su/*",
      "https://*.cuckcapital.cr/*",
      "https://girlsreleased.com/*",
      "https://*.girlsreleased.com/*",
      "https://*.imx.to/*",
    ],
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

  plugins: [
    webExtension({
      browser,
      manifest: () => makeManifest(browser),
      additionalInputs: ["src/offscreen/index.html"],
    }),
  ],
});

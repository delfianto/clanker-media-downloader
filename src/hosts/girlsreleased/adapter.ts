import type { MDConfig } from "../../types/global";
import type { HosterModel } from "../../types/hoster";
import {
  injectGalleryStyles,
  injectHosterStyles,
  wireGalleryButton,
  type GalleryCtx,
} from "../../content/shared/gallery-ui";

export function activate(_model: HosterModel, _config: MDConfig): void {
  // Viewer activation is not needed on girlsreleased.com itself
}

export function activateGallery(_model: HosterModel, ctx: GalleryCtx): void {
  injectGalleryStyles();
  injectHosterStyles(
    "girlsreleased",
    `
    .md-girlsreleased-gallery-btn {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      padding: 12px 24px;
      font-size: 14px;
      font-weight: 600;
      color: #ffffff;
      background: linear-gradient(135deg, #3b82f6, #1d4ed8);
      border: none;
      border-radius: 30px;
      box-shadow: 0 10px 25px rgba(59, 130, 246, 0.4);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      vertical-align: middle;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      transition: all 0.2s ease-in-out;
    }
    .md-girlsreleased-gallery-btn:hover:not(.loading) {
      transform: translateY(-2px);
      box-shadow: 0 15px 30px rgba(59, 130, 246, 0.5);
      background: linear-gradient(135deg, #2563eb, #1e40af);
    }
    .md-girlsreleased-gallery-btn:active:not(.loading) {
      transform: translateY(0);
    }
    .md-girlsreleased-gallery-btn.loading {
      background: #4b5563;
      box-shadow: none;
      cursor: default;
      pointer-events: none;
      opacity: 0.8;
    }
    `,
  );

  const dlIcon =
    '<span class="btn-icon" style="margin-right: 6px; font-size: 16px;">📥</span> <span class="btn-text">Download Gallery</span>';
  const loadingIcon =
    '<span class="btn-icon" style="margin-right: 6px; font-size: 16px;">⏳</span> <span class="btn-text">Downloading...</span>';

  const dlBtn = document.createElement("button");
  dlBtn.type = "button";
  dlBtn.className = "md-girlsreleased-gallery-btn";
  dlBtn.title = "Download Gallery";
  dlBtn.innerHTML = dlIcon;

  wireGalleryButton(dlBtn, loadingIcon, dlIcon, ctx.triggerDownload);
  document.body.appendChild(dlBtn);
}

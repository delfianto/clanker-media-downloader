import type { MDConfig } from "../../types/global";
import type { HosterModel } from "../../types/hoster";
import { resolveFilename } from "../../content/shared/filename";
import { wireButton } from "../../content/shared/wire";
import {
  injectGalleryStyles,
  injectHosterStyles,
  wireGalleryButton,
  type GalleryCtx,
} from "../../content/shared/gallery-ui";

export function activate(model: HosterModel, config: MDConfig): void {
  const cfg = model.downloadConfig;
  const button = document.querySelector<HTMLAnchorElement>(cfg.buttonSelector);
  if (!button) return;

  const url = button.href;
  if (!url) return;

  wireButton(button, url, () => resolveFilename(cfg.filenameStrategy), config, model);
}

export function activateGallery(_model: HosterModel, ctx: GalleryCtx): void {
  const headerRight = document.querySelector(".header-content-right");
  if (!headerRight) return;

  injectGalleryStyles();
  injectHosterStyles(
    "imgbb",
    `
    .md-imgbb-gallery-btn.loading {
      pointer-events: none;
      opacity: 0.6;
    }
  `,
  );

  const dlIcon =
    '<span class="btn-icon icon-download"></span><span class="btn-text phone-hide">Download</span>';
  const loadingIcon =
    '<span class="btn-icon icon-circle-notch icon-spin"></span><span class="btn-text phone-hide">Download</span>';

  const dlBtn = document.createElement("a");
  dlBtn.href = "javascript:void(0);";
  dlBtn.className = "btn green md-imgbb-gallery-btn";
  dlBtn.title = "Download Gallery";
  dlBtn.innerHTML = dlIcon;

  wireGalleryButton(dlBtn, loadingIcon, dlIcon, ctx.triggerDownload);
  headerRight.prepend(dlBtn);
}

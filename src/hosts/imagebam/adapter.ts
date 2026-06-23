import type { MDConfig } from "../../types/global";
import type { HosterModel } from "../../types/hoster";
import { injectButtonStyles } from "../../content/shared/ui";
import { resolveFilename } from "../../content/shared/filename";
import { wireButton } from "../../content/shared/wire";

export function activate(model: HosterModel, config: MDConfig): void {
  const cfg = model.downloadConfig;

  const downloadAnchor = document.querySelector<HTMLAnchorElement>(cfg.buttonSelector);
  if (!downloadAnchor) return;

  const image = cfg.imageSelector
    ? document.querySelector<HTMLImageElement>(cfg.imageSelector)
    : null;
  const url = image?.src || downloadAnchor.href;
  if (!url) return;

  injectButtonStyles();

  const dlBtn = document.createElement("button");
  dlBtn.type = "button";
  dlBtn.className = "md-icon-btn";
  dlBtn.title = "Download";
  dlBtn.innerHTML = '<i class="fas fa-download"></i>';

  const shareAnchor = document.querySelector<HTMLElement>(
    'a.dropdown-item[data-target="#modal-share-image"]',
  );
  const shareBtn = document.createElement("button");
  shareBtn.type = "button";
  shareBtn.className = "md-icon-btn";
  shareBtn.title = "Share";
  shareBtn.innerHTML = '<i class="fas fa-share-alt"></i>';
  shareBtn.addEventListener("click", () => {
    shareAnchor?.click();
  });

  const group = document.createElement("div");
  group.className = "md-icon-group";
  group.append(dlBtn, shareBtn);

  const viewSwitches = downloadAnchor.closest<HTMLElement>(".view-switches");
  if (viewSwitches) {
    viewSwitches.after(group);
    viewSwitches.style.display = "none";
  } else {
    downloadAnchor.after(group);
    downloadAnchor.style.display = "none";
  }

  wireButton(dlBtn, url, () => resolveFilename(cfg.filenameStrategy), config, model);
}

import type { HosterModel } from "../../types/hoster";
import { createIconSwapUI } from "../../content/shared/ui";
import { resolveFilename } from "../../content/shared/filename";
import { wireButton } from "../../content/shared/wire";

export function activate(model: HosterModel): void {
  const cfg = model.downloadConfig;

  const downloadAnchor = document.querySelector<HTMLAnchorElement>(cfg.buttonSelector);
  if (!downloadAnchor) return;

  const image = cfg.imageSelector
    ? document.querySelector<HTMLImageElement>(cfg.imageSelector)
    : null;
  const url = image?.src || downloadAnchor.href;
  if (!url) return;

  const dlBtn = document.createElement("button");
  dlBtn.type = "button";
  dlBtn.className = "md-action-btn";
  dlBtn.textContent = "Download";

  const shareBtn = document.createElement("button");
  shareBtn.type = "button";
  shareBtn.className = "md-action-btn";
  shareBtn.textContent = "Share";

  shareBtn.addEventListener("click", () => {
    void navigator.clipboard.writeText(location.href).then(() => {
      shareBtn.textContent = "Copied!";
      setTimeout(() => {
        shareBtn.textContent = "Share";
      }, 1200);
    });
  });

  const group = document.createElement("div");
  group.className = "md-action-group";
  group.append(dlBtn, shareBtn);

  // Replace the three-dot dropdown with our button group.
  const dropdown = downloadAnchor.closest<HTMLElement>(".dropdown");
  if (dropdown) {
    dropdown.after(group);
    dropdown.style.display = "none";
  } else {
    downloadAnchor.after(group);
    downloadAnchor.style.display = "none";
  }

  wireButton(dlBtn, url, () => resolveFilename(cfg.filenameStrategy), createIconSwapUI(dlBtn));
}

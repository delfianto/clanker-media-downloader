import type { HosterModel } from "../../types/hoster";
import { createIconSwapUI } from "../../content/shared/ui";
import { resolveFilename } from "../../content/shared/filename";
import { wireButton } from "../../content/shared/wire";

export function activate(model: HosterModel): void {
  const cfg = model.downloadConfig;
  // buttonSelector targets the icon; the clickable element is its anchor parent.
  const icon = document.querySelector(cfg.buttonSelector);
  const button = icon?.closest<HTMLAnchorElement>("a");
  if (!button) return;

  const image = cfg.imageSelector
    ? document.querySelector<HTMLImageElement>(cfg.imageSelector)
    : null;
  const url = image?.src || button.href;
  if (!url) return;

  wireButton(button, url, () => resolveFilename(cfg.filenameStrategy), createIconSwapUI(button));
}

import type { HosterModel } from "../../types/hoster";
import { resolveFilename } from "../../content/shared/filename";
import { downloadBlob } from "../../content/shared/downloader";

export function activate(model: HosterModel): void {
  const cfg = model.downloadConfig;
  const button = document.querySelector<HTMLAnchorElement>(cfg.buttonSelector);
  if (!button) return;

  button.removeAttribute("target");
  button.addEventListener("click", (event) => {
    event.preventDefault();

    // Read the signed CDN URL at click time: page JS sets #img-main.src
    // asynchronously via glb-apisign.cdn.cr/sign. By click time the image
    // is visible on screen, so the URL is always ready.
    const img = cfg.imageSelector
      ? document.querySelector<HTMLImageElement>(cfg.imageSelector)
      : null;
    const url = img?.src;
    if (!url?.startsWith("http")) return;

    void downloadBlob(url, resolveFilename(cfg.filenameStrategy) || "download");
  });
}

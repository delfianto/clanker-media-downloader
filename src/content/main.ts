import type { MDConfig } from "../types/global";
import type { HosterId, HosterModel } from "../types/hoster";
import { getModel } from "../hosts/index";
import { activate as activateImagebam } from "../hosts/imagebam/adapter";
import { activate as activateImgbox } from "../hosts/imgbox/adapter";
import { activate as activateImgbb } from "../hosts/imgbb/adapter";
import { activate as activateBunkr } from "../hosts/bunkr/adapter";
import { runGalleryAdapter } from "./shared/gallery-runner";

const ADAPTERS: Record<HosterId, (model: HosterModel) => void> = {
  imagebam: activateImagebam,
  imgbox: activateImgbox,
  imgbb: activateImgbb,
  bunkr: activateBunkr,
};

// MAIN world, document_idle. Registered synchronously at load — isolated.ts
// dispatches __md_config__ only after an async storage read, so this listener
// is always in place before the event fires. Its arrival is the activation
// signal: isolated.ts only sends it when the extension and the matched hoster
// are both enabled.
document.addEventListener(
  "__md_config__",
  (event) => {
    try {
      const config = JSON.parse((event as CustomEvent<string>).detail) as MDConfig;
      const model = getModel(config.hosterId);
      if (!model) return;

      if (config.pageType === "gallery") {
        runGalleryAdapter(model, config);
      } else {
        ADAPTERS[config.hosterId]?.(model);
      }
    } catch {}
  },
  { once: true },
);

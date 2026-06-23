import type { MDConfig } from "../types/global";
import type { HosterId, HosterModel } from "../types/hoster";
import { getModel } from "../hosts/index";
import {
  activate as activateImagebam,
  activateGallery as activateGalleryImagebam,
} from "../hosts/imagebam/adapter";
import {
  activate as activateImgbox,
  activateGallery as activateGalleryImgbox,
} from "../hosts/imgbox/adapter";
import {
  activate as activateImgbb,
  activateGallery as activateGalleryImgbb,
} from "../hosts/imgbb/adapter";
import {
  activate as activateBunkr,
  activateGallery as activateGalleryBunkr,
} from "../hosts/bunkr/adapter";
import {
  activate as activateErome,
  activateGallery as activateGalleryErome,
} from "../hosts/erome/adapter";
import {
  activate as activateJpg6,
  activateGallery as activateGalleryJpg6,
} from "../hosts/jpg6/adapter";
import {
  activate as activateGirlsreleased,
  activateGallery as activateGalleryGirlsreleased,
} from "../hosts/girlsreleased/adapter";
import { runGalleryAdapter, type GalleryAdapterFn } from "./shared/gallery-runner";

const ADAPTERS: Record<HosterId, (model: HosterModel, config: MDConfig) => void> = {
  imagebam: activateImagebam,
  imgbox: activateImgbox,
  imgbb: activateImgbb,
  bunkr: activateBunkr,
  erome: activateErome,
  jpg6: activateJpg6,
  girlsreleased: activateGirlsreleased,
};

const GALLERY_ADAPTERS: Record<HosterId, GalleryAdapterFn> = {
  imagebam: activateGalleryImagebam,
  imgbox: activateGalleryImgbox,
  imgbb: activateGalleryImgbb,
  bunkr: activateGalleryBunkr,
  erome: activateGalleryErome,
  jpg6: activateGalleryJpg6,
  girlsreleased: activateGalleryGirlsreleased,
};

// MAIN world, document_idle. Registered synchronously at load — isolated.ts
// dispatches __md_config__ only after an async storage read, so this listener
// is always in place before the event fires. Its arrival is the activation
// signal: isolated.ts only sends it when the extension and the matched hoster
// are both enabled.
document.addEventListener("__md_config__", (event) => {
  try {
    const config = JSON.parse((event as CustomEvent<string>).detail) as MDConfig;
    console.log("[md] main received config event:", config);
    const model = getModel(config.hosterId);
    if (!model) return;

    if (config.pageType === "gallery") {
      const galleryAdapter = GALLERY_ADAPTERS[config.hosterId];
      if (galleryAdapter) runGalleryAdapter(model, config, galleryAdapter);
    } else {
      ADAPTERS[config.hosterId]?.(model, config);
    }
  } catch {}
});

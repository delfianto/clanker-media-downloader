import type { MDConfig } from "../../types/global";
import type { HosterModel } from "../../types/hoster";
import { requestDownloadSingle } from "./bridge";

// MAIN world. Ask the bridge to request a download via background SW.
export async function downloadBlob(
  url: string,
  filename: string,
  config?: MDConfig,
  model?: HosterModel,
): Promise<void> {
  let subfolder = "";
  if (config) {
    let albumName = "";
    if (model?.getGalleryName) {
      const detected = model.getGalleryName(document);
      if (detected) {
        if (detected.startsWith("http")) {
          try {
            const res = await fetch(detected);
            if (res.ok) {
              const text = await res.text();
              const parser = new DOMParser();
              const doc = parser.parseFromString(text, "text/html");
              albumName = model.getGalleryName(doc) || "";
            }
          } catch (e) {
            console.error("[md] failed to fetch gallery name:", e);
          }
          if (!albumName) {
            albumName = detected.split("/").at(-1) || "";
          }
        } else {
          albumName = detected;
        }
      }
    }
    if (config.autoFolderPerAlbum && albumName) {
      const safeName = albumName.replace(new RegExp('[/\\\\:*?"<>|]', "g"), "_").trim();
      subfolder = config.downloadDirectory ? `${config.downloadDirectory}/${safeName}` : safeName;
    } else {
      subfolder = config.downloadDirectory;
    }
  }

  const result = await requestDownloadSingle(url, filename, subfolder);
  if ("error" in result) throw new Error(result.error);
}

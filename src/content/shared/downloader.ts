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
    let albumId = "";
    if (model?.getGalleryName) {
      albumId = model.getGalleryName(document) ?? "";
    }
    if (config.autoFolderPerAlbum && albumId) {
      subfolder = config.subfolderPrefix ? `${config.subfolderPrefix}/${albumId}` : albumId;
    } else {
      subfolder = config.subfolderPrefix;
    }
  }

  const result = await requestDownloadSingle(url, filename, subfolder);
  if ("error" in result) throw new Error(result.error);
}

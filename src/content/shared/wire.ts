import type { MDConfig } from "../../types/global";
import type { HosterModel } from "../../types/hoster";
import { downloadBlob } from "./downloader";

export function wireButton(
  button: HTMLElement,
  url: string,
  filename: () => string,
  config?: MDConfig,
  model?: HosterModel,
): void {
  button.removeAttribute("target");
  button.addEventListener("click", (event) => {
    event.preventDefault();
    void downloadBlob(url, filename() || "download", config, model);
  });
}

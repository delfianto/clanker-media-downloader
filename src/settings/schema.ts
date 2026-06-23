import type { Settings } from "../types/global";

// Single source of truth for default settings. Stores only the per-hoster
// override scaffold — redirectRules:null means "use the model's defaults" and
// cssOverrides:"" means none. Kept free of DOM/feature imports (pure data) so
// it can be imported by content scripts, the SW, the popup and the options page.
export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  hosters: {
    imagebam: { enabled: true, redirectRules: null, cssOverrides: "" },
    imgbox: { enabled: true, redirectRules: null, cssOverrides: "" },
    imgbb: { enabled: true, redirectRules: null, cssOverrides: "" },
    bunkr: { enabled: true, redirectRules: null, cssOverrides: "" },
  },
  maxParallel: 3,
  subfolderPrefix: "",
  autoFolderPerAlbum: true,
};

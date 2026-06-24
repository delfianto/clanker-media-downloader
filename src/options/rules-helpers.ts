import type { Settings } from "../types/global";
import type { HosterModel, RedirectRule } from "../types/hoster";
import { clone } from "./dom";

export function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

// Capture-group count via the empty-match trick: `pattern|` always matches "",
// and the result array has one slot per capture group (plus index 0).
export function groupCount(pattern: string): number {
  try {
    const match = new RegExp(`${pattern}|`).exec("");
    return match ? match.length - 1 : 0;
  } catch {
    return 0;
  }
}

export function maxTemplateRef(template: string): number {
  let max = 0;
  for (const m of template.matchAll(/\$(\d+)/g)) {
    max = Math.max(max, Number(m[1] ?? "0"));
  }
  return max;
}

// Rules to show: the stored override, or a fresh clone of the model defaults
// when the user hasn't customised them yet.
export function displayRules(model: HosterModel, settings: Settings): RedirectRule[] {
  return settings.hosters[model.id].redirectRules ?? clone(model.defaultRedirectRules);
}

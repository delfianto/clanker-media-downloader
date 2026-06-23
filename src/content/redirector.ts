import browser from "webextension-polyfill";
import type { Settings } from "../types/global";
import { ALL_MODELS } from "../hosts/index";
import { DEFAULT_SETTINGS } from "../settings/schema";
import { effectiveRules } from "../settings/resolve";

// ISOLATED world, document_start. Injected on CDN domains (*.imagebam.com,
// *.imgbox.com); at this point the page is just a raw CDN image URL. We read the
// effective redirect rules and, on a match, location.replace() to the hoster's
// viewer page — where the download adapter is already wired up. The storage read
// is async, but the browser is still fetching image bytes, so the redirect fires
// before anything renders. The same matches also cover viewer pages (e.g.
// www.imagebam.com); no CDN rule matches those URLs, so nothing happens there.
async function run(): Promise<void> {
  const stored = (await browser.storage.local.get(DEFAULT_SETTINGS)) as Settings;
  stored.hosters = { ...DEFAULT_SETTINGS.hosters, ...stored.hosters };
  if (!stored.enabled) return;

  const href = location.href;
  for (const model of ALL_MODELS) {
    const override = stored.hosters[model.id];
    if (!override.enabled) continue;

    for (const rule of effectiveRules(model, override)) {
      // Skip incomplete rules: an empty pattern would compile to a match-all
      // regex and redirect everything. Compile defensively so one bad
      // (e.g. half-typed) user pattern can't break the others on this page.
      if (!rule.pattern) continue;
      let match: RegExpExecArray | null;
      try {
        match = new RegExp(rule.pattern, "i").exec(href);
      } catch {
        continue;
      }
      if (!match) continue;

      // $1/$2 in the template reference the rule regex's capture groups.
      const target = rule.template.replace(/\$(\d+)/g, (_full, digits: string) => {
        return match[Number(digits)] ?? "";
      });
      location.replace(target);
      return;
    }
  }
}

void run().catch(() => {});

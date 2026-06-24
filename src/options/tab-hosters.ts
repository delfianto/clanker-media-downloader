import type { HosterId, HosterOverride, Settings } from "../types/global";
import type { HosterModel, RedirectRule } from "../types/hoster";
import { ALL_MODELS, getModel } from "../hosts/index";
import { $, el, toast, clone } from "./dom";
import { displayRules, groupCount, isValidRegex, maxTemplateRef } from "./rules-helpers";

export function renderSidebar(
  settings: Settings,
  selected: HosterId,
  onSelect: (id: HosterId) => void,
): void {
  const list = $("hoster-list");
  list.replaceChildren();
  for (const model of ALL_MODELS) {
    const on = settings.hosters[model.id].enabled;
    const item = el(
      "li",
      { className: model.id === selected ? "hoster-item active" : "hoster-item" },
      [
        el("span", { className: "name", textContent: model.displayName }),
        el("span", { className: on ? "dot on" : "dot" }),
      ],
    );
    item.addEventListener("click", () => {
      onSelect(model.id);
    });
    list.append(item);
  }
}

export function renderPanel(
  selected: HosterId,
  settings: Settings,
  persist: () => void,
  persistSoon: () => void,
  onUpdateSidebar: () => void,
): void {
  const model = getModel(selected);
  const panel = $("panel");
  panel.replaceChildren();
  if (!model) return;

  const override = settings.hosters[model.id];
  const toggle = el("input", { type: "checkbox", checked: override.enabled });
  toggle.addEventListener("change", () => {
    override.enabled = toggle.checked;
    persist();
    onUpdateSidebar();
  });

  panel.append(
    el("div", { className: "panel-head" }, [
      el("h2", { textContent: model.displayName }),
      el("label", { className: "hoster-toggle" }, [
        el("span", { textContent: "Enabled" }),
        el("span", { className: "switch" }, [toggle, el("span", { className: "slider" })]),
      ]),
    ]),
    ...(model.galleryConfig?.isBizarreName ? [renderFallbackNameSection(override, persist)] : []),
    renderRulesSection(model, settings, override, persist, persistSoon, () =>
      renderPanel(selected, settings, persist, persistSoon, onUpdateSidebar),
    ),
    renderCssSection(model, selected, settings, override, persist, persistSoon, onUpdateSidebar),
  );
}

function renderFallbackNameSection(override: HosterOverride, persist: () => void): HTMLElement {
  const toggle = el("input", { type: "checkbox", checked: override.useFallbackName ?? false });
  toggle.addEventListener("change", () => {
    override.useFallbackName = toggle.checked;
    persist();
  });

  return el("section", {}, [
    el("div", { className: "settings-field" }, [
      el("div", {}, [
        el("div", { className: "settings-label", textContent: "Use Fallback Name" }),
        el("div", {
          className: "settings-hint",
          textContent: "Use the ImageBam file ID when the filename is a UUID or garbled text",
        }),
      ]),
      el("label", { className: "hoster-toggle" }, [
        el("span", { className: "switch" }, [toggle, el("span", { className: "slider" })]),
      ]),
    ]),
  ]);
}

function renderRuleCard(
  model: HosterModel,
  rules: RedirectRule[],
  rule: RedirectRule,
  index: number,
  override: HosterOverride,
  persist: () => void,
  persistSoon: () => void,
  onRefreshPanel: () => void,
): HTMLElement {
  // Materialise the override from the displayed rules on any edit, then save.
  function touch(immediate: boolean): void {
    override.redirectRules = rules;
    if (immediate) persist();
    else persistSoon();
  }

  const enabled = el("input", { type: "checkbox", checked: rule.enabled });
  enabled.addEventListener("change", () => {
    rule.enabled = enabled.checked;
    touch(true);
  });

  const desc = el("input", {
    type: "text",
    className: "rule-desc",
    value: rule.description,
    placeholder: "Description",
  });
  desc.addEventListener("input", () => {
    rule.description = desc.value;
    touch(false);
  });

  const del = el("button", { className: "del-btn", title: "Delete rule", textContent: "✕" });
  del.addEventListener("click", () => {
    rules.splice(index, 1);
    override.redirectRules = rules;
    persist();
    onRefreshPanel();
  });

  const pattern = el("input", {
    type: "text",
    className: "rule-pattern mono",
    value: rule.pattern,
    placeholder: "^https?://…",
    spellcheck: false,
  });
  const patternMsg = el("p", { className: "field-msg" });

  const template = el("input", {
    type: "text",
    className: "rule-template mono",
    value: rule.template,
    placeholder: "https://…/$1",
    spellcheck: false,
  });
  const templateMsg = el("p", { className: "field-msg" });

  function validate(): void {
    const ok = pattern.value === "" || isValidRegex(pattern.value);
    pattern.classList.toggle("invalid", !ok);
    patternMsg.textContent = ok ? "" : "⚠ Invalid regex";
    patternMsg.className = ok ? "field-msg" : "field-msg error";

    const refs = maxTemplateRef(template.value);
    const groups = ok ? groupCount(pattern.value) : 0;
    if (ok && refs > groups) {
      templateMsg.textContent = `⚠ Template uses $${refs} but the pattern has ${groups} capture group(s)`;
      templateMsg.className = "field-msg warn";
    } else {
      templateMsg.textContent = "";
      templateMsg.className = "field-msg";
    }
  }

  pattern.addEventListener("input", () => {
    rule.pattern = pattern.value;
    validate();
    touch(false);
  });
  template.addEventListener("input", () => {
    rule.template = template.value;
    validate();
    touch(false);
  });
  validate();

  return el("div", { className: "rule" }, [
    el("div", { className: "rule-head" }, [enabled, desc, del]),
    el("label", { className: "field" }, ["Pattern", pattern]),
    patternMsg,
    el("label", { className: "field" }, ["Template", template]),
    templateMsg,
  ]);
}

function renderRulesSection(
  model: HosterModel,
  settings: Settings,
  override: HosterOverride,
  persist: () => void,
  persistSoon: () => void,
  onRefreshPanel: () => void,
): HTMLElement {
  const rules = displayRules(model, settings);

  const container = el("div", { className: "rules" });
  rules.forEach((rule, i) =>
    container.append(
      renderRuleCard(model, rules, rule, i, override, persist, persistSoon, onRefreshPanel),
    ),
  );

  const resetBtn = el("button", { className: "reset-btn", textContent: "↺ Reset" });
  resetBtn.addEventListener("click", () => {
    if (
      !confirm(`Discard all custom redirect rules for ${model.displayName} and restore defaults?`)
    ) {
      return;
    }
    override.redirectRules = null;
    persist();
    onRefreshPanel();
    toast("Rules reset to defaults");
  });

  const addBtn = el("button", { className: "add-btn", textContent: "+ Add Rule" });
  addBtn.addEventListener("click", () => {
    const next = override.redirectRules ?? clone(model.defaultRedirectRules);
    next.push({
      id: `${model.id}-custom-${Date.now()}`,
      description: "New rule",
      pattern: "",
      template: "",
      enabled: true,
    });
    override.redirectRules = next;
    persist();
    onRefreshPanel();
  });

  const section = el("section", {}, [
    el("div", { className: "section-head" }, [
      el("h3", { textContent: "Redirect Rules" }),
      resetBtn,
    ]),
    container,
    addBtn,
  ]);

  if (model.cdnMatches.length === 0) {
    section.append(
      el("p", {
        className: "empty-note",
        textContent:
          "This hoster has no CDN redirect — its thumbnails link straight to the viewer page, so rules here won't run.",
      }),
    );
  } else if (override.redirectRules === null) {
    section.append(
      el("p", {
        className: "default-note",
        textContent: "Using built-in defaults. Editing any field creates your own copy.",
      }),
    );
  }
  return section;
}

function renderCssSection(
  model: HosterModel,
  selected: HosterId,
  settings: Settings,
  override: HosterOverride,
  persist: () => void,
  persistSoon: () => void,
  onUpdateSidebar: () => void,
): HTMLElement {
  const textarea = el("textarea", {
    className: "css-editor mono",
    value: override.cssOverrides,
    spellcheck: false,
    placeholder: "/* custom CSS injected into this hoster's viewer page */",
  });
  textarea.addEventListener("input", () => {
    override.cssOverrides = textarea.value;
    persistSoon();
  });

  const resetBtn = el("button", { className: "reset-btn", textContent: "↺ Reset" });
  resetBtn.addEventListener("click", () => {
    override.cssOverrides = model.defaultCssOverrides;
    persist();
    renderPanel(selected, settings, persist, persistSoon, onUpdateSidebar);
    toast("CSS reset");
  });

  return el("section", {}, [
    el("div", { className: "section-head" }, [
      el("h3", { textContent: "CSS Overrides" }),
      resetBtn,
    ]),
    textarea,
  ]);
}

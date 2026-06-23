import browser from "webextension-polyfill";
import type { HosterId, Settings } from "../types/global";
import type { HosterModel, RedirectRule } from "../types/hoster";
import type { DownloadJob } from "../types/jobs";
import type { MDJobProgressMessage, MDListJobsResponse } from "../types/messages";
import { ALL_MODELS, getModel } from "../hosts/index";
import { DEFAULT_SETTINGS } from "../settings/schema";

let settings: Settings;
let selected: HosterId = "imagebam";
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

// Tiny typed createElement helper: props are real element properties (so
// className/value/checked/etc. are type-checked), children are nodes or text.
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node: HTMLElementTagNameMap[K] = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
}

// ── persistence ──────────────────────────────────────
function persist(): void {
  void browser.storage.local.set(settings as unknown as Record<string, unknown>).then(
    () => toast("Saved ✓"),
    () => toast("Save failed", true),
  );
}

function persistSoon(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 400);
}

function toast(message: string, isError = false): void {
  const node = $("toast");
  node.textContent = message;
  node.className = isError ? "toast show error" : "toast show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.className = "toast";
  }, 1600);
}

// ── validation helpers ───────────────────────────────
function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

// Capture-group count via the empty-match trick: `pattern|` always matches "",
// and the result array has one slot per capture group (plus index 0).
function groupCount(pattern: string): number {
  try {
    const match = new RegExp(`${pattern}|`).exec("");
    return match ? match.length - 1 : 0;
  } catch {
    return 0;
  }
}

function maxTemplateRef(template: string): number {
  let max = 0;
  for (const m of template.matchAll(/\$(\d+)/g)) {
    max = Math.max(max, Number(m[1] ?? "0"));
  }
  return max;
}

// Rules to show: the stored override, or a fresh clone of the model defaults
// when the user hasn't customised them yet.
function displayRules(model: HosterModel): RedirectRule[] {
  return settings.hosters[model.id].redirectRules ?? clone(model.defaultRedirectRules);
}

// ── rendering ────────────────────────────────────────
function renderSidebar(): void {
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
      selected = model.id;
      renderSidebar();
      renderPanel();
    });
    list.append(item);
  }
}

function renderRuleCard(
  model: HosterModel,
  rules: RedirectRule[],
  rule: RedirectRule,
  index: number,
): HTMLElement {
  const override = settings.hosters[model.id];

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
    renderPanel();
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

function renderRulesSection(model: HosterModel): HTMLElement {
  const override = settings.hosters[model.id];
  const rules = displayRules(model);

  const container = el("div", { className: "rules" });
  rules.forEach((rule, i) => container.append(renderRuleCard(model, rules, rule, i)));

  const resetBtn = el("button", { className: "reset-btn", textContent: "↺ Reset" });
  resetBtn.addEventListener("click", () => {
    if (
      !confirm(`Discard all custom redirect rules for ${model.displayName} and restore defaults?`)
    ) {
      return;
    }
    override.redirectRules = null;
    persist();
    renderPanel();
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
    renderPanel();
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

function renderCssSection(model: HosterModel): HTMLElement {
  const override = settings.hosters[model.id];

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
    renderPanel();
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

function renderPanel(): void {
  const model = getModel(selected);
  const panel = $("panel");
  panel.replaceChildren();
  if (!model) return;

  const override = settings.hosters[model.id];
  const toggle = el("input", { type: "checkbox", checked: override.enabled });
  toggle.addEventListener("change", () => {
    override.enabled = toggle.checked;
    persist();
    renderSidebar();
  });

  panel.append(
    el("div", { className: "panel-head" }, [
      el("h2", { textContent: model.displayName }),
      el("label", { className: "hoster-toggle" }, [
        el("span", { textContent: "Enabled" }),
        el("span", { className: "switch" }, [toggle, el("span", { className: "slider" })]),
      ]),
    ]),
    renderRulesSection(model),
    renderCssSection(model),
  );
}

// ── Downloads tab ─────────────────────────────────────
let dlRefreshTimer: ReturnType<typeof setInterval> | undefined;

function formatJobStatus(job: DownloadJob): string {
  if (job.status === "running") return `${job.completedCount} / ${job.totalCount}`;
  if (job.status === "done") {
    return job.failedCount > 0
      ? `Done — ${job.failedCount} failed`
      : `Done — ${job.totalCount} files`;
  }
  return `Error — ${job.failedCount} failed`;
}

function renderJobCard(job: DownloadJob): HTMLElement {
  const statusClass =
    job.status === "running" ? "running" : job.status === "done" ? "done" : "error";
  const pct = job.totalCount > 0 ? job.completedCount / job.totalCount : 0;

  const progress = el("progress", {});
  progress.setAttribute("value", String(job.completedCount));
  progress.setAttribute("max", String(job.totalCount));

  return el("div", { className: "job-card", id: `job-${job.jobId}` }, [
    el("div", { className: "job-header" }, [
      el("span", { className: "job-title", textContent: job.subfolder || job.hosterId }),
      el("span", { className: `job-status ${statusClass}`, textContent: formatJobStatus(job) }),
    ]),
    progress,
    el("div", { className: "job-meta" }, [
      el("span", {
        className: "job-pct",
        textContent: `${Math.round(pct * 100)}%`,
      }),
      el("span", {
        className: "job-hoster",
        textContent: job.hosterId,
      }),
    ]),
  ]);
}

function renderDownloadsSettings(): void {
  const container = $("dl-settings");
  container.replaceChildren();

  // Max parallel
  const parallelInput = el("input", {
    type: "number",
    className: "narrow",
    value: String(settings.maxParallel),
    min: "1",
    max: "10",
  } as Partial<HTMLInputElement>);
  parallelInput.addEventListener("change", () => {
    const v = Math.min(10, Math.max(1, Number(parallelInput.value) || 3));
    parallelInput.value = String(v);
    settings.maxParallel = v;
    persistSoon();
  });

  // Auto-folder toggle
  const autoFolderToggle = el("input", {
    type: "checkbox",
    checked: settings.autoFolderPerAlbum,
  });
  autoFolderToggle.addEventListener("change", () => {
    settings.autoFolderPerAlbum = autoFolderToggle.checked;
    persist();
  });

  // Subfolder prefix
  const prefixInput = el("input", {
    type: "text",
    value: settings.subfolderPrefix,
    placeholder: "e.g. bunkr-saves",
  });
  prefixInput.addEventListener("input", () => {
    settings.subfolderPrefix = prefixInput.value;
    persistSoon();
  });

  container.append(
    el("div", { className: "settings-field" }, [
      el("div", {}, [
        el("div", { className: "settings-label", textContent: "Max parallel downloads" }),
        el("div", { className: "settings-hint", textContent: "1–10 files at a time" }),
      ]),
      parallelInput,
    ]),
    el("div", { className: "settings-field" }, [
      el("div", {}, [
        el("div", { className: "settings-label", textContent: "Auto-folder per album" }),
        el("div", {
          className: "settings-hint",
          textContent: "Creates Downloads/{prefix}/{albumId}/ per job",
        }),
      ]),
      el("label", { className: "hoster-toggle" }, [
        el("span", { className: "switch" }, [
          autoFolderToggle,
          el("span", { className: "slider" }),
        ]),
      ]),
    ]),
    el("div", { className: "settings-field" }, [
      el("div", {}, [
        el("div", { className: "settings-label", textContent: "Subfolder prefix" }),
        el("div", {
          className: "settings-hint",
          textContent: "Relative path inside your browser's downloads folder",
        }),
      ]),
      prefixInput,
    ]),
  );
}

async function loadDownloadsTab(): Promise<void> {
  renderDownloadsSettings();

  const jobsContainer = $("dl-jobs");
  jobsContainer.replaceChildren(el("p", { className: "default-note", textContent: "Loading…" }));

  try {
    const res = (await browser.runtime.sendMessage({ type: "MD_LIST_JOBS" })) as MDListJobsResponse;
    jobsContainer.replaceChildren();
    if (res.jobs.length === 0) {
      jobsContainer.append(
        el("p", { className: "default-note", textContent: "No downloads yet." }),
      );
    } else {
      for (const job of res.jobs) jobsContainer.append(renderJobCard(job));
    }
  } catch {
    jobsContainer.replaceChildren(
      el("p", { className: "default-note", textContent: "Could not load jobs." }),
    );
  }
}

// ── Tabs ──────────────────────────────────────────────
type Tab = "hosters" | "downloads";
let activeTab: Tab = "hosters";

function switchTab(tab: Tab): void {
  activeTab = tab;

  $("tab-hosters").classList.toggle("active", tab === "hosters");
  $("tab-hosters").setAttribute("aria-selected", String(tab === "hosters"));
  $("tab-downloads").classList.toggle("active", tab === "downloads");
  $("tab-downloads").setAttribute("aria-selected", String(tab === "downloads"));

  const hostersView = $("view-hosters");
  const downloadsView = $("view-downloads");

  if (tab === "hosters") {
    hostersView.removeAttribute("hidden");
    downloadsView.setAttribute("hidden", "");
    clearInterval(dlRefreshTimer);
  } else {
    hostersView.setAttribute("hidden", "");
    downloadsView.removeAttribute("hidden");
    void loadDownloadsTab();
    // Refresh job list every 3s while the tab is open.
    dlRefreshTimer = setInterval(() => void loadDownloadsTab(), 3000);
  }
}

// ── init ─────────────────────────────────────────────
async function init(): Promise<void> {
  try {
    settings = (await browser.storage.local.get(DEFAULT_SETTINGS)) as Settings;
  } catch {
    settings = clone(DEFAULT_SETTINGS);
  }
  // Heal missing hosters (corrupted storage / a hoster added in a new version).
  for (const model of ALL_MODELS) {
    settings.hosters[model.id] ??= clone(DEFAULT_SETTINGS.hosters[model.id]);
  }
  // Heal missing gallery settings (upgrade from older storage schema).
  settings.maxParallel ??= DEFAULT_SETTINGS.maxParallel;
  settings.subfolderPrefix ??= DEFAULT_SETTINGS.subfolderPrefix;
  settings.autoFolderPerAlbum ??= DEFAULT_SETTINGS.autoFolderPerAlbum;

  $<HTMLSpanElement>("version").textContent = `v${browser.runtime.getManifest().version}`;

  const master = $<HTMLInputElement>("master-enabled");
  master.checked = settings.enabled;
  master.addEventListener("change", () => {
    settings.enabled = master.checked;
    persist();
  });

  $("tab-hosters").addEventListener("click", () => switchTab("hosters"));
  $("tab-downloads").addEventListener("click", () => switchTab("downloads"));

  // Live progress updates from the SW while the Downloads tab is open.
  // Update card DOM elements in-place to avoid needing the full job object.
  browser.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as Partial<MDJobProgressMessage>;
    if (m.type !== "MD_JOB_PROGRESS" || activeTab !== "downloads") return;
    const card = document.getElementById(`job-${m.jobId ?? ""}`);
    if (!card) return;

    const progressEl = card.querySelector("progress");
    if (progressEl) {
      progressEl.setAttribute("value", String(m.completedCount ?? 0));
      progressEl.setAttribute("max", String(m.totalCount ?? 0));
    }

    const statusEl = card.querySelector<HTMLElement>(".job-status");
    if (statusEl) {
      const st = m.status ?? "running";
      const completed = m.completedCount ?? 0;
      const total = m.totalCount ?? 0;
      const failed = m.failedCount ?? 0;
      statusEl.className = `job-status ${st}`;
      if (st === "running") statusEl.textContent = `${completed} / ${total}`;
      else if (st === "done")
        statusEl.textContent = failed > 0 ? `Done — ${failed} failed` : `Done — ${total} files`;
      else statusEl.textContent = `Error — ${failed} failed`;
    }

    const pctEl = card.querySelector<HTMLElement>(".job-pct");
    const total = m.totalCount ?? 0;
    if (pctEl && total > 0)
      pctEl.textContent = `${Math.round(((m.completedCount ?? 0) / total) * 100)}%`;
  });

  renderSidebar();
  renderPanel();
}

void init();

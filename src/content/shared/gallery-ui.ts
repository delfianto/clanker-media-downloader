const STYLE_ID = "md-gallery-styles";

export function injectGalleryStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .md-gallery-btn {
      display: inline-flex; align-items: center; gap: 6px;
      background: #3b82f6; color: #fff; border: none;
      padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 600;
      cursor: pointer; transition: background 0.15s, opacity 0.15s;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .md-gallery-btn:hover:not(:disabled) { background: #2563eb; }
    .md-gallery-btn:disabled { opacity: 0.55; cursor: default; }
    .md-gallery-btn-wrap {
      display: flex; align-items: center; gap: 10px;
      margin: 8px 0 12px;
    }
    .md-gallery-note { font-size: 11px; color: #71717a; }
    .main-content .view-switches a.md-ib-gallery-btn {
      position: relative;
      top: -0.05em;
      cursor: pointer;
      margin-right: 12px;
      opacity: 0.6;
      font-size: 0.9em;
      transition: opacity 0.15s;
    }
    .main-content .view-switches a.md-ib-gallery-btn:hover {
      opacity: 1;
    }
    .main-content .view-switches a.md-ib-gallery-btn.loading {
      pointer-events: none;
      opacity: 1;
    }
    .md-imgbox-gallery-btn {
      color: inherit;
      cursor: pointer;
      opacity: 0.6;
      font-size: 0.9em;
      transition: opacity 0.15s;
    }
    .md-imgbox-gallery-btn:hover {
      opacity: 1;
    }
    .md-imgbox-gallery-btn.loading {
      pointer-events: none;
      opacity: 1;
    }
    @keyframes md-spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  `;
  (document.head ?? document.documentElement).appendChild(style);
}

export function createDownloadAllButton(
  totalCount: number,
  note: string | undefined,
  onClick: () => void,
): HTMLElement {
  injectGalleryStyles();

  const btn = document.createElement("button");
  btn.className = "md-gallery-btn";
  btn.textContent = `⬇ Download All (${totalCount})`;

  btn.addEventListener("click", () => {
    btn.disabled = true;
    btn.textContent = "Queued…";
    onClick();
  });

  const wrap = document.createElement("div");
  wrap.className = "md-gallery-btn-wrap";
  wrap.appendChild(btn);

  if (note) {
    const noteEl = document.createElement("span");
    noteEl.className = "md-gallery-note";
    noteEl.textContent = note;
    wrap.appendChild(noteEl);
  }

  return wrap;
}

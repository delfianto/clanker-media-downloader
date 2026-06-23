// Shared download-feedback UI. One idempotent <style> injection; everything
// else is class toggles or innerHTML swaps on the button element.

export interface DownloadUI {
  showSpinner(message?: string): void;
  showSuccess(message?: string): void;
  showError(message?: string): void;
  reset(): void;
}

const STYLE_ID = "md-ui-styles";

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .md-btn-busy { pointer-events: none; opacity: 0.6; }
    .md-inline-spinner {
      display: inline-block; width: 14px; height: 14px;
      border: 2px solid rgba(127,127,127,0.35); border-top-color: currentColor;
      border-radius: 50%; animation: md-spin 0.8s linear infinite;
      vertical-align: middle;
    }
    .md-action-group { display: inline-flex; gap: 6px; align-items: center; }
    .md-action-btn {
      background: transparent; border: 1px solid rgba(127,127,127,0.4);
      color: inherit; border-radius: 4px; padding: 4px 12px;
      font-size: 12px; font-family: inherit; cursor: pointer;
      min-width: 72px; text-align: center;
      transition: background 0.15s, border-color 0.15s;
    }
    .md-action-btn:hover { background: rgba(127,127,127,0.1); border-color: rgba(127,127,127,0.7); }
    .md-action-btn.md-btn-busy { pointer-events: none; opacity: 0.55; }
    @keyframes md-spin { to { transform: rotate(360deg); } }
  `;
  (document.head ?? document.documentElement).appendChild(style);
}

// Swaps the button's inner HTML with a spinner while downloading, then
// restores it. Works for both the imgbox icon anchor and the imagebam
// injected buttons — no side text, no separate status element.
export function createIconSwapUI(buttonEl: HTMLElement): DownloadUI {
  ensureStyles();
  const savedHTML = buttonEl.innerHTML;

  return {
    showSpinner(): void {
      buttonEl.classList.add("md-btn-busy");
      buttonEl.innerHTML = '<span class="md-inline-spinner"></span>';
    },
    showSuccess(): void {
      buttonEl.classList.remove("md-btn-busy");
      buttonEl.innerHTML = savedHTML;
    },
    showError(): void {
      buttonEl.classList.remove("md-btn-busy");
      buttonEl.innerHTML = savedHTML;
    },
    reset(): void {
      buttonEl.classList.remove("md-btn-busy");
      buttonEl.innerHTML = savedHTML;
    },
  };
}

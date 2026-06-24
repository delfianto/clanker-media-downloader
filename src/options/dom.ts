export function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

// Tiny typed createElement helper: props are real element properties (so
// className/value/checked/etc. are type-checked), children are nodes or text.
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node: HTMLElementTagNameMap[K] = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string, isError = false): void {
  const node = $<HTMLDivElement>("toast");
  node.textContent = message;
  node.className = isError ? "toast show error" : "toast show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.className = "toast";
  }, 1600);
}

// A small DOM helper instead of a framework (ADR-022): h() builds elements,
// renderList() reconciles a keyed list in place.

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

/**
 * Creates an element. Attributes: `class`, `on<event>` listeners (e.g.
 * `onclick`), booleans set or remove the attribute, null/undefined are skipped.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === 'function') {
      element.addEventListener(name.slice(2), value);
    } else {
      element.setAttribute(name, value === true ? '' : String(value));
    }
  }
  append(element, children);
  return element;
}

/** An SVG element (the brand mark, icons, the Fleet map); strings become text nodes. */
export function svg(tag: string, attrs: Record<string, string> = {}, ...children: (SVGElement | string)[]): SVGElement {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  element.append(...children);
  return element;
}

function append(parent: Element, children: (Child | Child[])[]): void {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : String(child));
  }
}

/** Replaces the children of `element`. */
export function replaceChildren(element: Element, ...children: (Child | Child[])[]): void {
  element.replaceChildren();
  append(element, children);
}

/**
 * Renders `items` into `container` keyed by `key`: existing elements are kept
 * and updated, new ones created, missing ones removed, and the order follows
 * `items`. Keeps focus and scroll position across live updates. Works for
 * HTML and SVG children alike.
 */
export function renderList<T, E extends HTMLElement | SVGElement = HTMLElement>(
  container: Element,
  items: readonly T[],
  key: (item: T) => string,
  create: (item: T) => E,
  update: (element: E, item: T) => void = () => undefined,
): void {
  const existing = new Map<string, E>();
  for (const child of Array.from(container.children)) {
    if ((child instanceof HTMLElement || child instanceof SVGElement) && child.dataset['key'] !== undefined) {
      existing.set(child.dataset['key'], child as E);
    }
  }
  let cursor: Element | null = container.firstElementChild;
  for (const item of items) {
    const id = key(item);
    let element = existing.get(id);
    if (element) {
      existing.delete(id);
      update(element, item);
    } else {
      element = create(item);
      element.dataset['key'] = id;
    }
    if (element !== cursor) container.insertBefore(element, cursor);
    else cursor = cursor.nextElementSibling;
  }
  for (const stale of existing.values()) stale.remove();
}

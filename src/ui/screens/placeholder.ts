// The stage with the mockup's title block, used by the screens that are not
// built yet.

import { h, replaceChildren } from '../shared/dom.js';

export function renderPlaceholder(element: HTMLElement, screen: string, title: string, text: string): () => void {
  replaceChildren(
    element,
    h('section', { class: 'stage', 'data-screen': screen }, h('div', { class: 'title' }, h('h1', null, title), h('p', null, text))),
  );
  return () => {
    element.replaceChildren();
  };
}

// The "Copy" button next to a command: copies `text` and says "Copied" for a
// moment. A failed clipboard write (no permission, insecure context) does
// nothing; the command stays on screen to select by hand.

import { h } from './dom.js';

const COPIED_MS = 1600;

export function copyButton(text: string, label = 'Copy the command'): HTMLButtonElement {
  const button = h('button', { type: 'button', class: 'btn copy', 'aria-label': label }, 'Copy');
  button.addEventListener('click', (event) => {
    // Inside a clickable row or card, copying is all the click does.
    event.stopPropagation();
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        button.textContent = 'Copied';
        setTimeout(() => {
          button.textContent = 'Copy';
        }, COPIED_MS);
      })
      .catch(() => undefined);
  });
  return button;
}

// Repo (SPEC.md section 6): the dynamic change list of one repo (section 3a).
// The list, its filters and badges are built on this mount point.

import { renderPlaceholder } from '../placeholder.js';

export function mountRepo(element: HTMLElement, repoId: number): () => void {
  const unmount = renderPlaceholder(element, 'repo', 'Changes', 'Drafts, branches and pull requests of this repo appear here, newest first.');
  element.dataset['repoId'] = String(repoId);
  return () => {
    delete element.dataset['repoId'];
    unmount();
  };
}

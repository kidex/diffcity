// The standalone page of the change screen (ADR-002, ADR-022): a Report in a
// <script type="application/json" id="diffcity-report"> element, the screen
// mounted from it with no ports and nothing else: no daemon, no SSE, no review
// marks, no Fleet card. It is what the HTML export will be built from (phase
// 5); in phase 3 it only exists for tests (vite.standalone.config.ts) and
// proves the screen renders from a Report alone. It imports nothing from
// src/ui/data or src/ui/app (ESLint, test/unit/standalone).

import '../shared/tokens.css';
import '../shared/base.css';
import '../shared/components.css';
import '../shared/fonts.js';
import './standalone.css';

import type { Report } from '../../core/report/types.js';
import { mountChange } from '../screens/change/index.js';
import { h, replaceChildren } from '../shared/dom.js';

export const REPORT_ELEMENT_ID = 'diffcity-report';

function isReport(value: unknown): value is Report {
  return typeof value === 'object' && value !== null && Array.isArray((value as { packages?: unknown }).packages);
}

/** The Report embedded in the page; throws a short message when there is none or it is not JSON. */
function embeddedReport(): Report {
  const source = document.getElementById(REPORT_ELEMENT_ID);
  if (source === null) throw new Error(`This page has no #${REPORT_ELEMENT_ID} element.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.textContent);
  } catch {
    throw new Error('The embedded report is not valid JSON.');
  }
  if (!isReport(parsed)) throw new Error('The embedded report is not a diffcity Report.');
  return parsed;
}

const view = document.getElementById('view');
if (view !== null) {
  const stage = h('section', { class: 'stage change', 'data-screen': 'change' });
  const body = h('div', { class: 'change-body' });
  try {
    const report = embeddedReport();
    replaceChildren(stage, body);
    replaceChildren(view, stage);
    mountChange(body, { report, crumb: true });
  } catch (error) {
    // textContent only: the message is plain text, never markup.
    const message = h('p', { class: 'standalone-error', role: 'alert', 'data-testid': 'standalone-error' });
    message.textContent = error instanceof Error ? error.message : 'The report could not be shown.';
    replaceChildren(view, message);
  }
}

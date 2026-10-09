// The Session tab's body (ADR-038): one card per Claude Code session linked to
// the change, built from the reading panel's own pieces (groups, tags, the
// finding card's surface, the symbol rows). Session text (titles, prompts,
// answers, agent descriptions and reports, file paths, MCP server names) is
// untrusted: every piece goes in through textContent. An agent row is a
// button that shows or hides its report and activity; an edited file the
// Report has is a button that selects its building.

import { h } from '../../../shared/dom.js';
import type { ActivityView, RunRow, SessionCard, SessionTab } from '../model/session.js';
import { NO_ANSWER, NOT_READ_SESSION, UNREADABLE_SESSION } from '../model/session.js';
import type { TabActions, TabBody } from './lists.js';

export interface SessionBodyState {
  /** Expanded agent rows, by `focusKey` (session key and run key). */
  expanded: Set<string>;
}

let ids = 0;
const nextId = (prefix: string): string => `${prefix}-${String(++ids)}`;

const heading = (text: string, testId: string): HTMLElement => h('h4', { class: 'sess-h', 'data-testid': testId }, text);

function fileList(activity: ActivityView, actions: TabActions, scope: string, cardKey: string): HTMLElement | null {
  if (activity.files.length === 0 && activity.more === null && activity.outside === null) return null;
  return h(
    'div',
    { class: 'sess-files' },
    activity.files.length === 0
      ? null
      : h(
          'ul',
          { class: 'plain-list', 'aria-label': `Edited files, ${scope}` },
          activity.files.map((file) =>
            h(
              'li',
              null,
              file.fileId === null
                ? h('span', { class: 'sess-file absent', 'data-testid': 'edited-file', 'data-path': file.path, title: 'Not in this change' }, file.path)
                : h(
                    'button',
                    {
                      type: 'button',
                      class: 'sess-file',
                      'data-testid': 'edited-file',
                      'data-path': file.path,
                      'data-file': file.fileId,
                      'data-focus-key': `${cardKey}\u0000${scope}\u0000${file.path}`,
                      title: `Select ${file.path}`,
                      onclick: () => {
                        if (file.fileId !== null) actions.select({ fileId: file.fileId, symbolId: null });
                      },
                    },
                    file.path,
                  ),
            ),
          ),
        ),
    activity.more === null ? null : h('p', { class: 'sess-more', 'data-testid': 'edited-more' }, activity.more),
    activity.outside === null ? null : h('p', { class: 'sess-more', 'data-testid': 'edited-outside' }, activity.outside),
  );
}

function chips(activity: ActivityView): HTMLElement | null {
  if (activity.chips.length === 0) return null;
  return h(
    'ul',
    { class: 'sess-chips', 'aria-label': 'Tool calls' },
    activity.chips.map((chip) =>
      h('li', { class: 'tag', 'data-testid': 'activity-chip', 'data-kind': chip.kind }, chip.label, ' ', h('b', null, String(chip.count))),
    ),
  );
}

function runItem(row: RunRow, card: SessionCard, actions: TabActions, state: SessionBodyState): HTMLElement {
  const key = `${card.key}\u0000${row.key}`;
  const open = state.expanded.has(key);
  const detailId = nextId('sess-run');
  const detail = h(
    'div',
    { class: 'sess-run-detail', id: detailId, 'data-testid': 'run-detail', hidden: !open },
    h('p', { class: 'sess-more', 'data-testid': 'run-status-source' }, row.statusSource),
    row.run.report === null
      ? h('p', { class: 'sess-more', 'data-testid': 'run-no-report' }, 'No report')
      : h(
          'div',
          { class: 'sess-report', 'data-testid': 'run-report' },
          row.run.report,
          row.run.reportTruncated ? h('span', { class: 'sess-more' }, ' (cut short)') : null,
        ),
    chips(row.activity),
    fileList(row.activity, actions, row.type, key),
  );
  const button = h(
    'button',
    {
      type: 'button',
      class: 'sess-run-row',
      'aria-expanded': String(open),
      'aria-controls': detailId,
      'data-testid': 'run-toggle',
      'data-focus-key': key,
      onclick: () => {
        const next = !state.expanded.has(key);
        if (next) state.expanded.add(key);
        else state.expanded.delete(key);
        button.setAttribute('aria-expanded', String(next));
        detail.hidden = !next;
      },
    },
    h('span', { class: 'sess-caret', 'aria-hidden': 'true' }),
    h('span', { class: 'tag sess-type', 'data-testid': 'run-type' }, row.type),
    h('span', { class: 'sess-desc', 'data-testid': 'run-description' }, row.description),
    h(
      'span',
      { class: 'sess-run-tags' },
      row.duration === null ? null : h('span', { class: 'sess-dur', 'data-testid': 'run-duration' }, row.duration),
      h('span', { class: `tag sess-status ${row.run.status}`, 'data-testid': 'run-status', title: row.statusSource }, row.status),
      row.run.here ? h('span', { class: 'tag add', 'data-testid': 'run-here', title: 'Worked in this change’s working tree' }, 'here') : null,
    ),
  );
  const item = h('li', { class: 'sess-run', 'data-testid': 'session-run', 'data-depth': row.depth, 'data-here': String(row.run.here), 'data-run': row.key }, button, detail);
  item.style.setProperty('--depth', String(row.depth));
  return item;
}

function content(card: SessionCard, actions: TabActions, state: SessionBodyState): (HTMLElement | null)[] {
  if (card.state === 'unreadable') return [h('p', { class: 'panel-empty sess-empty', role: 'status', 'data-testid': 'session-unreadable' }, UNREADABLE_SESSION)];
  if (card.state === 'unread') return [h('p', { class: 'panel-empty sess-empty', 'data-testid': 'session-unread' }, NOT_READ_SESSION)];
  const parts: (HTMLElement | null)[] = [];
  if (card.prompts.length > 0 || card.promptsMore !== null) {
    parts.push(
      h(
        'section',
        { class: 'sess-sec', 'data-testid': 'session-prompts' },
        heading('Prompts', 'session-prompts-heading'),
        card.promptsMore === null ? null : h('p', { class: 'sess-more' }, card.promptsMore),
        h(
          'ol',
          { class: 'plain-list' },
          card.prompts.map((prompt) =>
            h(
              'li',
              { class: `sess-prompt${prompt.command ? ' command' : ''}`, 'data-testid': 'session-prompt' },
              prompt.text,
              prompt.truncated ? h('span', { class: 'sess-more' }, ' …') : null,
            ),
          ),
        ),
      ),
    );
  }
  if (card.questions.length > 0 || card.questionsMore !== null) {
    parts.push(
      h(
        'section',
        { class: 'sess-sec', 'data-testid': 'session-questions' },
        heading('Questions', 'session-questions-heading'),
        card.questionsMore === null ? null : h('p', { class: 'sess-more' }, card.questionsMore),
        h(
          'ul',
          { class: 'plain-list' },
          card.questions.map((question) =>
            h(
              'li',
              { class: 'sess-qa', 'data-testid': 'session-question' },
              question.header === '' ? null : h('span', { class: 'tag', 'data-testid': 'question-header' }, question.header),
              h('p', { class: 'sess-q', 'data-testid': 'question-text' }, question.question),
              h(
                'p',
                { class: `sess-a${question.answer === null ? ' none' : ''}`, 'data-testid': 'question-answer' },
                question.answer ?? NO_ANSWER,
              ),
            ),
          ),
        ),
      ),
    );
  }
  if (card.runs.length > 0 || card.elsewhere !== null || card.runsMore !== null) {
    parts.push(
      h(
        'section',
        { class: 'sess-sec', 'data-testid': 'session-runs' },
        heading('Agents', 'session-runs-heading'),
        card.runs.length === 0 ? null : h('ul', { class: 'plain-list sess-runs' }, card.runs.map((row) => runItem(row, card, actions, state))),
        card.runsMore === null ? null : h('p', { class: 'sess-more' }, card.runsMore),
        card.elsewhere === null ? null : h('p', { class: 'sess-more', 'data-testid': 'session-elsewhere' }, card.elsewhere),
      ),
    );
  }
  if (card.main !== null && (card.main.chips.length > 0 || card.main.files.length > 0 || card.main.outside !== null)) {
    parts.push(
      h(
        'section',
        { class: 'sess-sec', 'data-testid': 'session-main' },
        heading('Main agent', 'session-main-heading'),
        chips(card.main),
        fileList(card.main, actions, 'main agent', card.key),
      ),
    );
  }
  const wide = card.wide === null ? null : fileList(card.wide, actions, 'whole session', card.key);
  if (wide !== null) {
    parts.push(h('section', { class: 'sess-sec', 'data-testid': 'session-wide' }, heading('Edited files, whole session', 'session-wide-heading'), wide));
  }
  return parts;
}

function sessionCard(card: SessionCard, actions: TabActions, state: SessionBodyState): HTMLElement {
  return h(
    'section',
    { class: 'group sess', 'data-testid': 'session-card', 'data-state': card.state, 'aria-label': card.title },
    h(
      'div',
      { class: 'sess-head' },
      h('h3', { class: `sess-title${card.untitled ? ' untitled' : ''}`, 'data-testid': 'session-title' }, card.title),
      h(
        'span',
        { class: 'sess-tags' },
        card.here ? h('span', { class: 'tag add', 'data-testid': 'session-here', title: 'Ran in this change’s working tree' }, 'here') : null,
        card.active ? h('span', { class: 'tag', 'data-testid': 'session-active' }, 'active') : null,
      ),
      card.range === '' ? null : h('p', { class: 'sess-range', 'data-testid': 'session-range' }, card.range),
    ),
    card.notes.map((note) => h('p', { class: 'sess-note', role: 'note', 'data-testid': 'session-note' }, note)),
    content(card, actions, state),
  );
}

export function sessionBody(tab: SessionTab, actions: TabActions, state: SessionBodyState): TabBody {
  const root = h(
    'div',
    { class: 'tab-body', 'data-testid': 'tab-session-body' },
    tab.shown === null ? null : h('p', { class: 'section-note sess-shown', 'data-testid': 'sessions-shown' }, tab.shown),
    tab.cards.map((card) => sessionCard(card, actions, state)),
  );
  return { root, stops: [], symbols: [] };
}

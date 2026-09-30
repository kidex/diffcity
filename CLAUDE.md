# diffcity

A local visual code review app for code written by AI agents. `SPEC.md` is the source of truth; `design/mockup.html` is the visual reference for the change screen. Read the relevant SPEC.md section before touching any rule, command or screen.

## Roles

- The main session is the team lead: it breaks phases into Jira tasks, dispatches work to subagents, moves tasks through states, merges, tags, writes phase reports.
- The human is the PO: approves plans, decides on ambiguities, accepts phases.
- Subagents live in `.claude/agents/`: architect, dev-core, dev-ui, reviewer, tester.

Task flow: Jira task → architect (only if a decision is needed) → dev-core or dev-ui in a worktree → reviewer → tester → team lead merges, moves the task to Done, comments a summary.

## Non-negotiable rules

- **Section 5 of SPEC.md (status, verdict, tier 1, execution path, findings import) and section 3a (collection, dynamic change list) are implemented exactly.** Any deviation is flagged to the PO and recorded as an ADR in Confluence before it is merged. The `spec-rules` skill has the checklist.
- **All computation lives in `src/core` and runs in the daemon.** The UI receives a ready-made `Report` and only renders, filters, hovers and selects. The change screen must render from a `Report` alone (it doubles as the HTML export).
- **Public repo.** Zero personal paths, zero secrets, zero real client or project names in code, tests, fixtures, Jira or Confluence. Fixtures use invented names.
- **Tests never touch the real `~/.config/diffcity`.** They use a temporary directory passed through configuration.
- **Ambiguity:** ask the PO a single precise question with your recommended option. Do not guess on spec rules.

## Code

- Strict TypeScript, ESM, Node 20+, a single npm package with `bin`.
- Layout: `src/cli/`, `src/daemon/` (server, api, sse, watcher, collector, scheduler), `src/core/` (git, parse, diff, verdict, path, findings, db), `src/ui/`, `test/fixtures/`.
- Parsing through `web-tree-sitter` (wasm) and `ts-morph`; UI with Vite and `three` from npm (ADR-003).
- Every rule in SPEC.md section 5 has unit tests on small fixtures.
- Collection runs in worker threads.

## Git

- Conventional commits with the Jira key: `feat(DC-12): ...`, `fix(DC-20): ...`, `test(DC-15): ...`. One commit per logical step.
- No AI attribution anywhere: no `Co-Authored-By`, no "generated with" lines in commits, PRs, code or docs.
- Branches: `DC-<nr>-<slug>`. Worktrees live under `.worktrees/` (gitignored): `git worktree add .worktrees/DC-<nr>-<slug> -b DC-<nr>-<slug>`.
- Only the team lead merges, and only after reviewer and tester approve. No force push.
- Everything committed is in English. README and docs describe what the project is; tasks and plans live in Jira.

## Atlassian

- Jira project `DC`, Confluence space `DI`, through the Atlassian MCP. The `jira-flow` and `confluence-docs` skills describe formats and states.
- Jira and Confluence content is written in Romanian, matching the existing pages.

## Commands

- `npm test` runs vitest; `npm run lint`; `npm run build`; `npm run typecheck`.
- Hooks in `.claude/hooks/` enforce the guardrails; do not bypass them.

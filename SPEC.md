# diffcity

A local, all-in-one visual code review app for code written by AI agents. It runs as a daemon on your machine, watches every repo you work in, and builds the list of changes (working tree, branches, open PRs) for each one on its own. Any change opens as a 3D city: every package is a lot, every file a building, every function a floor. The review verdict floats above every touched building. A side panel reads the change in the order the code runs, with findings anchored to symbols.

The name `diffcity` is final: the npm package `diffcity` and the GitHub repo `kidex/diffcity` are both available.

`design/mockup.html` is the mandatory reference for layout, information and behaviour: the change screen has every element, counter, label, filter and interaction of the mockup. The city's visual style is "Night data city" (ADR-026): dark glass towers on a grid, floors as light strips in their status colour, a verdict-coloured outline per tower, holographic verdict tags, a pulsing reading path, restrained bloom.

---

## 1. Who and why

| | |
|---|---|
| User | A single senior developer working with Claude Code on several repos in parallel |
| Problem | Vibe-coded diffs are large and chaotic; line-by-line review is slow and tiring |
| Desired outcome | In 5 minutes you understand what the agent built, where the risk is, and what deserves a manual read |
| Context | Personal tool, run locally, presentable to a team as a demo; public repo on GitHub |

Division of labour: the AI writes the line-by-line comments (imported as findings). diffcity provides the canvas on which the human understands the change.

---

## 2. v1 scope

| In v1 | Deferred (backlog) |
|---|---|
| TypeScript and JavaScript | Java, PHP, Python (tree-sitter adds them once the model is stable) |
| Symbol-level semantic diff (before/after) | Impact map on untouched code |
| Local app (daemon + browser UI) with a dynamic list of changes per repo | Advanced dedup across reviewers |
| Filters by verdict and by change type | |
| Reading in execution order | Hover with full call graph |
| Findings import (own JSON + SARIF) | Direct Claude API integration |
| `/code-review` slash command + Stop hook for Claude Code | GitHub Action, hosted dashboard, GitHub App |
| Automatic collection when entering a repo (shell hook) and on every Claude Code session | PUML class diagram |
| Project registry with `status` and `audit` | |
| PlantUML sequence export of the execution path | |
| Self-contained HTML export of a change (phase 5): the same change screen, with the `Report` embedded and three.js inlined, like `design/mockup.html` | |
| Claude Code session context on the change screen (phase 4): the user's prompts, the agent's `AskUserQuestion` questions with the answers, the agents that ran (each subagent with its type, description, order, duration and final report) and a summary of the agent's activity (tool calls by kind, files edited); read locally, redacted, never exported unless asked | Session context for agents other than Claude Code |
| Approve → integrate (phase 5): after Approve, explicit merge into the base, push of the branch, and open or update of the PR via `gh`; off by default, each action confirmed with its exact command, never force | Auto-merge, rebase, squash, force-push |
| Review marks per file and symbol (Checked, Looks good, Needs rewrite) with a markdown review summary (phase 3); send the review to the agent that wrote the change (phase 4) | |
| Review rules whose violations become findings: file size and import layering (phase 4), CI pipeline status and CVEs in added or upgraded npm dependencies (phase 5) | |

---

## 3. CLI commands

```
diffcity start [<dir>] [--port 4321] [--no-open]       # the one command to use: start the daemon if needed, register the repo at <dir> (or the current repo) and open it in the browser
diffcity stop                                          # stop the daemon
diffcity up [--port 4321]                              # start the daemon and open the UI (localhost); start without a repo
diffcity shell-init [zsh|bash|fish]                    # print the shell hook; add to .zshrc: eval "$(diffcity shell-init zsh)"
diffcity track [<dir>] [--agent]                       # register the current repo and ask the daemon to collect; --agent marks the change as "agent worked, not reviewed" and links the Claude Code session from the hook JSON on stdin
diffcity trust [<dir>] [--list] [--remove]             # let the daemon load this repo's diffcity.config.js; --list shows trusted repos, --remove withdraws trust
diffcity scan <dir>                                    # discover repos (folders with .git) under a folder and register them
diffcity diff --json [--compact] [--base] [--head]     # semantic diff of the current change, for AI and other tools; --compact leaves out untouched files
diffcity import <findings.json|*.sarif.json> [--open]  # anchor findings to symbols and attach them to the current change; --open opens the change in the UI
diffcity setup-claude [--repo [<dir>]] [--dry-run] [--remove]  # install the /code-review command and the Stop hook for Claude Code (section 7)
diffcity export html|puml [--out]                      # self-contained export of the current change (phase 5)
diffcity status                                        # repos ordered by urgency (unreviewed changes, stale audit)
diffcity audit [--stale] [<repo>]                      # full audit (deps, semgrep, gitleaks, AI on tier 1)
```

Global install (`npm i -g diffcity`) or `npx`. Defaults: the base is detected per repo (`main`, then `master`, then the default branch from `gh`), overridable in `diffcity.config.js`.

Session context (phase 4): when stdin is not a TTY, `track --agent` reads the Claude Code hook JSON from it (`session_id`, `transcript_path`, `cwd`; at most 64 KB) and passes it to the daemon. `cwd` replaces the default `<dir>`. The daemon reads the transcript locally and links the session to the change checked out in `cwd`. `diff --json` and `export html` never include session data; `--with-sessions` adds it explicitly and requires the daemon.

Integrate (phase 5) has no CLI command: merge, push and PR run only from the change screen, after Approve and an explicit confirmation.

---

## 3a. Automatic collection

| Trigger | What happens |
|---|---|
| You `cd` into a folder with `.git` (`chpwd`/`PROMPT_COMMAND` hook) | `diffcity track` registers the repo if missing and asks the daemon to collect; costs under 50 ms, the rest is asynchronous |
| The daemon is running | watches `.git/refs`, `.git/HEAD` and the working tree of active repos (chokidar, or recursive `fs.watch` for working trees on macOS; ADR-020); on change it recomputes only the affected change, with a 2 s debounce |
| Claude Code finishes a task (Stop hook) | `diffcity track --agent` marks the change as "agent worked, not reviewed" |
| `/code-review` from the editor | findings land on the current change and update its verdicts |
| Every 15 min, per active repo | `gh pr list --json` (if `gh` is installed and authenticated) refreshes open PRs |

- The shell hook calls `track` in the background only when you enter a repo (its root or any subfolder) or move to another repo; moving between folders of the same repo does nothing (ADR-016).
- A repo is active (watched and polled for PRs) if you entered it, an agent worked in it, or you opened it in the UI in the last 7 days. Repos found by `scan` are registered inactive and collected once (ADR-020).
- The 2 s debounce has a 10 s maximum wait, so the UI updates at least every 10 s while an agent keeps writing (ADR-020).
- diffcity's own files `.diffcity/findings.json`, `.diffcity/fix-queue.json` and `.diffcity/fix-queue.taking.json` (the queue while `/code-review` applies it, ADR-037) are never part of a change: they are left out of the touched files and ignored by the watcher, so an import or a queued fix creates no Draft and no recollect (ADR-036). Every other file under `.diffcity/` is a normal file.

### Change list per repo

Built dynamically from three sources, deduplicated on `head`:

| Source | How it is detected | UI label |
|---|---|---|
| Working tree | `git status --porcelain` with uncommitted changes | Draft |
| Local branch | `git for-each-ref` with commits ahead of the base | Branch |
| Open PR | `gh pr list` (or a remote branch with an associated PR) | PR #N |

Each change has: a title (first commit message or PR title), ahead/behind, touched files and symbols by status, aggregated verdicts, review state (`unreviewed`, `in-review`, `approved`), the last event (agent, commit, review) and its time. Merged or deleted changes move to the archive and remain viewable for 90 days.

Clarifications approved by the PO (ADR-019):

- Uncommitted changes on a branch that already has commits ahead belong to that branch's change, marked as having uncommitted changes. A separate Draft appears only on the base, on a branch with no commits ahead, or on a detached HEAD. Linked worktrees count as working trees of the same repo.
- diffcity never runs `git fetch`. An open PR whose head commit is not available locally shows its title and number without counters until the user fetches.
- Every change that disappears (merged, deleted, closed PR, cleaned draft) is archived, stays viewable for 90 days, then is deleted with its snapshots. A merged or closed change does not come back while its head stays the same.
- An `approved` change returns to `unreviewed` when its head moves or its content changes.

---

## 4. Data model

### 4.1 Report (computed in the daemon, served over the API; embedded in the HTML export)

```ts
type Status = 'add' | 'mod' | 'sig' | 'del' | 'same';
type Verdict = 'eyes' | 'risky' | 'spec' | 'ok' | 'same';

interface Report {
  meta: { repo: string; base: string; head: string; commits: number; generatedAt: string; };
  packages: Package[];
  steps: Step[];            // execution path
  findings: Finding[];
  checks?: RuleCheck[];     // one per configured rule (phase 4)
  summary: { files: number; byStatus: Record<Status, number>; byVerdict: Record<Verdict, number>; tier1Files: string[]; };
}
interface Package { id: string; path: string; tier1: boolean; files: File[]; }
interface File {
  id: string; path: string; language: string; status: Status; verdict: Verdict;
  inSpec: boolean | null;   // null when there is no spec
  symbols: Symbol[];
}
interface Symbol {
  id: string; name: string; kind: 'class' | 'function' | 'method' | 'export' | 'sql';
  status: Status; range: { start: number; end: number }; signatureBefore?: string; signatureAfter?: string;
  callsites?: number;       // how many calls the agent rewrote, for 'sig'
}
interface Step { order: number; symbolId: string; fileId: string; why: string; diff: DiffLine[];
                 section?: 'path' | 'migration' | 'unconnected';   // missing is read as 'path' (ADR-034)
                 entry?: string; }                                   // symbolId of the entry point the step hangs from
interface DiffLine { kind: 'ctx' | 'add' | 'del'; text: string; }
interface Finding {
  id: string; source: string;                 // 'claude' | 'semgrep' | 'eslint' | 'rule:<id>' | ...
  sources?: string[];                          // every source of a deduplicated entry, always including source (ADR-036)
  severity: 'high' | 'med' | 'low';
  category: 'security' | 'correctness' | 'scope' | 'style' | 'tests' | 'architecture';
  file: string; line: number; symbolId?: string;   // symbolId is resolved on import; file '' and line 0 for a change-level finding
  title: string; message: string; fix?: string;
  state: 'open' | 'intended' | 'fixed';
}
interface RuleCheck { ruleId: string; kind: 'file-size' | 'layers' | 'pipeline' | 'cve'; state: 'passed' | 'violations' | 'not-checked' | 'pending' | 'error'; reason?: string; findings: number; checkedAt: string; }
```

### 4.2 Database (`~/.config/diffcity/diffcity.db`, SQLite via Node's built-in `node:sqlite`, no native build; ADR-025)

| Table | Contents |
|---|---|
| repos | path, name, base, active, tier1Paths, lastAudit (at, commit, model, rulesetVersion), lastSeenAt |
| changes | repoId, kind (draft/branch/pr), ref, head, base, title, ahead, behind, reviewState, approvedHead, approvedAt, lastEvent, updatedAt, archivedAt |
| snapshots | changeId, head, mergeBase, serialized `Report` (JSON), content fingerprints per file and symbol, computedAt; one per head, the latest is the one shown |
| findings | changeId, head, serialized `Finding`, state |
| review_marks | changeId, target (file or symbol id), mark (checked / good / rewrite), note, line range, fingerprint, state (current / outdated); review_notes: changeId, note |
| events | repoId, changeId, type (collect/agent/commit/review/import/audit/integrate), at, payload |
| sessions | repoId, sessionId, transcriptPath, cwd, title, firstAt, lastAt, digest (redacted, size-capped JSON; never the transcript), parsedBytes; linked to changes many-to-many through change_sessions (changeId, firstHead, lastHead) |

User settings live in `~/.config/diffcity/settings.json` (JSON, never read from a repo): trusted repos, rules, agent launch, integrate, tool paths.

A change's report (`Report` from 4.1) keeps the same structure; it is computed in the daemon and served to the UI over the API.

---

## 5. Rules

### 5.1 Symbol status

| Status | Rule |
|---|---|
| add | the symbol exists only in after |
| del | the symbol exists only in before |
| sig | same name, the signature (parameters, types, return) differs |
| mod | same name and signature, different body |
| same | identical |

A file's status = the "heaviest" status among its symbols, in the order sig > add > del > mod > same. A new file has all symbols add.

- The signature is the declared text: parameter names, types, defaults, explicit return type and `async`. Inferred types are ignored, so renaming a parameter gives `sig` and a change to an inferred return type alone gives `mod` (ADR-006).
- Changes to whitespace or comments only, including a reformat, give `same`. Directive comments (`@ts-ignore`, `@ts-expect-error`, `eslint-disable`) count as body changes and give `mod` (ADR-005).
- A touched file with no changed symbol (a non-code file, a binary, a TS file with only import changes, a pure rename) takes its status from git: `add`, `del` or `mod` (ADR-008).
- A code file larger than 2 MiB on either side is not parsed and is treated as a non-code file: no symbols, status from git. A whitespace- or comment-only change to such a file therefore gives `mod`, not `same` (ADR-033).

### 5.2 File verdict

| Verdict | Rule | UI label |
|---|---|---|
| eyes | file in a tier 1 zone or with at least one `sig` symbol | Needs your eyes |
| risky | has at least one open finding with high severity | Risky |
| spec | `inSpec === false` (change outside the task) | Outside the spec |
| ok | touched, zero open high findings | Reviewed, fine |
| same | zero changes | Untouched |

Evaluation follows the table order; the first matching rule wins, except that an untouched file is always `same`, checked first, even inside a tier 1 zone (ADR-009, as in the mockup).

### 5.3 Tier 1 zones (default, overridable in `diffcity.config.js`; the daemon applies a repo's config only after `diffcity trust`)

Paths containing: `auth`, `guard`, `security`, `session`, `payment`, `billing`, `migration`, `schema`, `infra`, `k8s`, `terraform`, `Dockerfile`, `.env`, `secrets`.

Matching is a case-insensitive substring of the path relative to the repo root, with `/` separators, so `OAuthButton.tsx` is tier 1; false positives are removed in `diffcity.config.js` (ADR-007).

### 5.4 Execution path

1. Entry points, in priority order: newly registered or modified HTTP routes, controller handlers, `main`/CLI entry, scheduled jobs, new tests.
2. From each entry point, BFS over the call graph restricted to touched symbols; call resolution uses ts-morph for TS and tree-sitter + name matching for JS.
3. Touched SQL migrations go at the end, after the last repo/DB symbol.
4. Touched symbols left outside every path form the "Unconnected" section at the end of the list.
5. The `why` field is generated from simple rules (new endpoint, signature changed with N call sites, schema modified) and can be overridden from findings.

### 5.5 Spec and "Outside the spec"

If `.diffcity/spec.md` exists (or the `--spec` argument is given), touched files with no link to the symbols on paths starting from the spec get `inSpec: false`. Without a spec, `inSpec` stays `null` and the `spec` verdict is disabled. This rule ships in phase 4 with the execution path; until then `inSpec` is always `null` (ADR-010).

### 5.6 Findings import

- Own format: an array of `Finding` without `symbolId`.
- SARIF 2.1: `results[]` → `Finding` (ruleId → title, level → severity, physicalLocation → file/line, tool.driver.name → source).
- Anchoring: the line maps to the symbol whose `range` contains it, in the `after` version. Findings without a symbol stay at file level.
- Simple dedup: same `symbolId` + `category` + normalized title → a single entry with the list of sources. The merged entry is `intended` if any part is, otherwise `open` if any part is, and `fixed` only when every part is (ADR-036).
- Findings belong to the change, not to one head: on each served Report they are re-anchored against the latest snapshot by file, symbol name and kind, then by line. An imported finding may carry a one-line `why` hint that replaces the reading-path text of its symbol's step.
- `fixed`: on an import, a stored `open` finding of a source the import covers, which the import no longer reports and whose anchor changed since it was imported, becomes `fixed`; a finding whose file left the change is `fixed`. A snapshot alone never marks a finding `fixed`.
- Rule findings (`source: "rule:<id>"`) are anchored the same way. A finding with no file (`file: ""`, for example a failed CI check without annotations) belongs to the change: it shows in the top bar and the Findings tab and changes no file verdict.

---

## 6. The app and its screens

A Node daemon (Fastify) serves the UI on `localhost:4321` plus a JSON API and SSE for live updates. The UI is a single-page app (Vite + TypeScript, no heavy framework; `three` from npm at the current release for the scene), with the Sora and IBM Plex Mono fonts and a local fallback. All screens use the colour tokens and components from `design/mockup.html`.

| Screen | Contents |
|---|---|
| Fleet (home) | all repos as lots on an overview map: colour is audit age, size is the number of unreviewed changes; below the map, the repo list with counters (draft/branch/PR, high findings, last audit); click enters the repo |
| Repo | the dynamic change list (section 3a), sorted by last event, with state badges and aggregated verdicts; filters by kind and reviewState; "Audit now" button |
| Change | the 3D city and the reading panel, with the mockup's layout, information and behaviour in the "Night data city" style (table below); live update while the agent keeps writing code |
| Top bar, on every screen | fleet / repo / change breadcrumb, daemon indicator, quick search (Cmd+K) by repo, branch or file |

### The change screen

| Area | Behaviour (as in the mockup, Night data city style) |
|---|---|
| Top bar | repo, branch vs base, counters of files and symbols by status, "N files need your eyes" badge, Export PlantUML and Approve buttons (disabled until every touched tier 1 file has a current review mark); after Approve, an Integrate menu (Merge into base, Push branch, Open/update PR; phase 5) |
| 3D city | lots = packages (tier 1 with a dotted orange outline), buildings = files with an inset, floors = symbols coloured by status, `del` floors as a dotted red skeleton, file name label on the roof of touched buildings, verdict badge above, roof pins for findings (colour by severity), dotted ground path with numbered discs; critical floors (changed floors of eyes, risky or tier 1 files, floors with an open high finding) pulse in their verdict colour, a static glow under prefers-reduced-motion; an X marker for each rule finding; a check mark on reviewed files and floors |
| Camera | drag to orbit, scroll to zoom, R to reset, short intro animation (disabled under prefers-reduced-motion) |
| Filters | row 1: verdicts (Needs your eyes, Risky, Outside the spec, Reviewed fine, Untouched) with counters; row 2: change type (Added, Modified, Signature changed, Removed) with counters, plus "Show everything". Filters combine (AND). A type filter dims floors of other types and buildings with no matching floors. Clicking an active filter turns it off; a third row, Rules, with a counter per rule, shown only when the change has rule findings; Hide checked hides files and floors with a current review mark |
| Hover | tooltip with verdict, file, package, counters by status, the floor under the cursor, number of findings |
| Click building | selects, highlights and opens the file view in the right panel: the file's stops in the reading path, then the read-only diff of the file, or of the clicked floor's symbol, with syntax highlighting, line numbers, folded unchanged regions and N / Shift+N for the next and previous hunk; Esc returns to the tabs |
| Right panel | tabs: Execution order, Findings, Outside the spec, Symbols, Session; each stop shows the symbol, file, file verdict, status tag, `why`, inline diff, findings with source, and the "Ask agent to fix" / "Mark as intended" buttons; J/K navigate. Session (phase 4) shows one card per Claude Code session linked to the change: title and time range, the user's prompts, the agent's questions with the answers, the agents that ran (type, description, order, duration, final report), activity by kind and the edited files (click selects the building); hidden when there is no session data |
| Review marks | per file and per symbol: Checked (C), Looks good (G), Needs rewrite (W, with a note and an optional line range), undo (U); stored by the daemon per change; a mark becomes outdated, and counts as unchecked, when its file's or symbol's content changes in a new snapshot; the HUD shows "N of M files that need your eyes checked"; Review summary renders the needs-rewrite notes as markdown to copy (phase 3) or to send to the agent (phase 4) |
| Rule checks | one chip per configured rule: passed, N violations, pending, or not checked with the reason; a rule that could not run is never shown as passed |
| Fleet (card) | bottom-right card with the last audit of the other repos, red above 30 days or with new CVEs; click goes to the fleet screen |
| Theme | dark by default, light under prefers-color-scheme: light; colours as tokens on :root |

"Ask agent to fix" writes the finding to `.diffcity/fix-queue.json` in the repo; the slash command picks it up. "Mark as intended" sets `state: 'intended'` in the DB and removes it from the verdict computation. "Approve" sets `reviewState: 'approved'` on the change, records the approved head, and unlocks only after every touched tier 1 file has a current review mark.

Integrate (phase 5) is off by default and enabled per repo in the user's diffcity settings, never by the repo. Each action opens a confirmation that shows the exact command, and runs only after it is confirmed. The daemon refuses when the change is not approved, when its head has moved since approval, when it has uncommitted changes, or when it is a Draft. It never force-pushes, rebases or squashes. Commands run without a shell, and their output is shown in the dialog.

Send review to the agent (phase 4) is off by default and enabled per repo in the user's diffcity settings, never by the repo. It shows the exact command and the full summary and runs only after confirmation: `claude --resume <session_id> -p` in the change's working tree with the summary on stdin, or a new `claude -p` session there when no session of that working tree is known. It never passes a permission-bypass flag, runs without a shell, and is logged.

---

## 7. Claude Code integration

### 7.1 `.claude/commands/code-review.md`

`diffcity setup-claude` writes this file to `commands/code-review.md` in the user's Claude Code configuration (`$CLAUDE_CONFIG_DIR` or `~/.claude`), or to `.claude/commands/code-review.md` of a repo with `--repo [<dir>]`, and merges the Stop hook of 7.2 into the `settings.json` next to it. `--dry-run` prints what would change; `--remove` removes only what diffcity wrote. When the `diffcity` on the `PATH` is not the CLI running setup, every `diffcity` below (and in the hook) is `"<absolute node>" "<absolute dist/cli/index.js>"`, so the `allowed-tools` entries match the commands the body runs (ADR-037). The line after the frontmatter is the version marker: setup overwrites or removes the file only when that line is exactly `<!-- diffcity: code-review v1 -->`, and refuses otherwise.

```
---
description: Review the current change with diffcity and put the findings on the city
argument-hint: [what the task was]
allowed-tools: Bash(diffcity diff:*), Bash(diffcity import:*), Bash(mv .diffcity/fix-queue.json .diffcity/fix-queue.taking.json), Bash(rm .diffcity/fix-queue.taking.json), Read, Write(.diffcity/findings.json)
---
<!-- diffcity: code-review v1 -->
First take the fixes queued from diffcity. If `.diffcity/fix-queue.taking.json` exists, an earlier run
stopped halfway: apply it and delete it as below before anything else.
Run `mv .diffcity/fix-queue.json .diffcity/fix-queue.taking.json`; when `.diffcity/fix-queue.json` does not exist, nothing is queued.
Otherwise read `.diffcity/fix-queue.taking.json` (`{ "version": 1, "items": [...] }`) and apply every item:
an item with `file`, `line`, `title`, `message` and `fix` is a finding to fix; an item with
`kind: "review-summary"` is the reviewer's summary, in `message`.
Then run `rm .diffcity/fix-queue.taking.json`.

Run `diffcity diff --json --compact` and read the result: it is the semantic diff of the current change
(touched files and symbols, changed signatures with call sites, the execution path, tier 1 zones).
Review this change with a focus on: security (auth/authz, input validation, secrets),
correctness (unhandled errors, edge cases, money arithmetic), scope creep relative to $ARGUMENTS,
tests that actually assert something, architecture violations.
Write the findings to `.diffcity/findings.json` as a JSON array, one object per finding, with
`source: "claude"`, `file`, `line`, `severity` (`high`, `med` or `low`), `category` (`security`,
`correctness`, `scope`, `style`, `tests` or `architecture`), `title` (one line), `message` (what is
wrong and when it breaks) and `fix` (the change to make). `file` is the repo-relative path of a file
in the diff and `line` a line of its current version: never invent a file or a line.
Set `why`, a one-line hint on why the code is there, only on a `scope` finding.
Write `[]` when you find nothing.
Then run `diffcity import .diffcity/findings.json --open`.
```

The fix queue is renamed to `.diffcity/fix-queue.taking.json` before it is applied, so an item the daemon queues meanwhile lands in a new `.diffcity/fix-queue.json` and is neither lost nor applied twice; `.diffcity/fix-queue.taking.json` is an own file like the queue (3a). `diff --json --compact` is the Report without untouched files and without the packages left with none; `meta`, `steps`, `findings`, `checks` and `summary` are unchanged, and without `--json` the flag has no effect. `--open` opens the change after the import because the user asked for the review (ADR-001).

### 7.2 Stop hook (`.claude/settings.json`)

```json
{ "hooks": { "Stop": [ { "matcher": "", "hooks": [ { "type": "command", "command": "diffcity track --agent" } ] } ] } }
```

`diffcity setup-claude` adds this entry under `hooks.Stop` unless a hook with the identical command is there, keeps every other key and hook, refuses a `settings.json` it cannot parse, writes through a temporary file and a rename, and keeps a one-time backup `settings.json.diffcity-backup`. The command is `diffcity track --agent` for a global install, otherwise `"<absolute node>" "<absolute dist/cli/index.js>" track --agent`; setup prints the one it chose.

The hook does not open the browser; the UI updates live over SSE. It never blocks the agent: on any failure (no daemon can start, a directory outside a repo, a refusal) it prints one line on stderr and exits 0.

Claude Code passes the hook JSON (`session_id`, `transcript_path`, `cwd`, `hook_event_name`) on stdin, and `track --agent` forwards it to the daemon, so the command stays the same. The daemon reads the transcript only if it lies under the Claude Code projects directory and is named after `session_id`. It stores only a redacted, size-capped digest, never the transcript.

### 7.3 Send review to the agent

Send review to the agent (phase 4) is off by default and enabled per repo in the user's diffcity settings, never by the repo. It shows the exact command and the full summary and runs only after confirmation: `claude --resume <session_id> -p` in the change's working tree with the summary on stdin, or a new `claude -p` session there when no session of that working tree is known. It never passes a permission-bypass flag, runs without a shell, and is logged. The session id comes from the Stop hook input that `track --agent` forwards (§3).

---

## 8. Full audit

| Step | What runs | Tool |
|---|---|---|
| Dependencies | new CVEs on the lockfile | `npm audit --json` (v1 npm only) |
| Code | default semgrep rules + custom ones from `.diffcity/rules/` | semgrep, if installed; otherwise the step is skipped with a warning |
| Secrets | on history since the last audit | gitleaks, if installed |
| AI | review only of tier 1 files changed since `lastAudit.commit` | via the slash command, with `--since <commit>` |

A repo is "stale" when: 30 days have passed since the last audit, `npm audit` reports new CVEs, the ruleset has grown, or there are changes with `reviewState: 'unreviewed'` older than 3 days. `status` and the fleet screen sort by the number of conditions met, then by age. The daemon checks CVEs once a day per active repo.

---

## 9. Phases and definition of done

| Phase | Deliverable | Done when |
|---|---|---|
| 0 | Public repo, strict TS, vitest, eslint, CI on GitHub Actions, `design/mockup.html` in the repo, `docs/findings.md` with the format; complete `.claude/` (agents, skills, hooks, settings, CLAUDE.md) per section 10a; epics and tasks in Jira; base pages in Confluence | `npm test` green, `diffcity --help` works, a sample task passes through the full flow architect → dev → reviewer → tester → Done |
| 1 | TS/JS semantic diff: git diff → before/after symbols → status, verdict, tier 1 | `diff --json` correct on 3 real changes, with fixture tests (add, mod, sig, del, new file, deleted file) |
| 2 | Daemon + DB + collection: `up`, `shell-init`, `track`, `scan`, watcher, dynamic change list (draft/branch/PR), Fleet and Repo screens, SSE | you `cd` into any of your repos and within 5 seconds it appears in the UI with all its changes (kind, title, ahead/behind; status and verdict counters on the test repo), with no manual command (ADR-023) |
| 3 | Change screen: 3D city in the Night data city style, hover, select, verdict, type and rule filters, file view with the diff, review marks and summary, pulsing critical floors, live update | the screen has the mockup's layout, information and behaviour on the 3 changes; it updates on its own when the agent writes code; it renders from a Report alone; review marks survive a reload and become outdated when their code changes; it holds 60 fps at a pixel ratio of 2 on a 3200×2000 canvas on the reference city |
| 4 | Execution path, reading panel, findings + SARIF import, slash command, Stop hook with session context (Session tab: prompts, agent questions and answers, agents that ran, activity summary), Ask agent to fix / Mark as intended / Approve, send review to the agent, review rules (file size, layering) | `/code-review` from the editor puts the pins on the city with no manual steps; after a Claude Code session in a repo, its change shows that session and the agents that ran in the Session tab with no manual steps, with secrets redacted, and the HTML export and `diff --json` contain no session data |
| 5 | `audit`, `status`, fleet map with audit age, self-contained HTML and PlantUML export, light theme, approve → integrate (merge into base, push branch, open/update PR via `gh`), README with GIF, review rules for CI pipeline and CVEs | a 3-minute demo run end to end in front of the team, including an approved change merged or opened as a PR from the change screen after confirmation; integrate is refused for a change that is not approved or whose head moved, and no force path exists |

Each phase closes with a `v0.<phase>.0` tag and a CHANGELOG entry.

---

## 10. Code constraints

- Strict TypeScript, Node 22.13+, ESM, a single npm package with `bin`; the UI is built with Vite into `dist/ui` and served by the daemon. The same build also produces a single-file variant of the change screen for the HTML export.
- Structure: `src/cli/`, `src/daemon/` (server, API, SSE, watcher, collector, scheduler), `src/core/` (git, parse, diff, verdict, path, findings, db), `src/ui/` (SPA: fleet, repo and change screens; three.js scene), `test/fixtures/`.
- The daemon runs a single instance (lock file in `~/.config/diffcity/`); `track` talks to it over a local socket and starts the daemon if it is missing.
- Parsers: `tree-sitter` + `tree-sitter-typescript`/`tree-sitter-javascript` via `web-tree-sitter` (wasm, so install works without a native build); `ts-morph` for call resolution in TS.
- Zero personal paths, zero secrets, zero client names in code, tests or fixtures. The repo is public.
- Every rule in section 5 has unit tests on small fixtures.
- Conventional commits (`feat:`, `fix:`, `test:`), one commit per logical step.
- All computation (diff, verdict, path, findings anchoring) lives in `src/core` and runs in the daemon; the UI receives a ready-made `Report` and only does rendering, filters, hover and selection. The change screen renders from a `Report` alone, so it also works without the daemon (HTML export).
- Collection runs in worker threads so the UI and API stay responsive on large repos.
- External tools (gh, npm, semgrep, gitleaks, claude) run through one hardened runner: absolute binaries outside any repo, argument arrays, an environment allow-list with the git guards, timeouts and output caps; a tool that cannot run gives "not checked", never a pass (ADR-032).

---

## 10a. How Claude Code works on the project: agent team, guardrails, skills

The main Claude Code session is the team lead and orchestrates. The human is the PO: approves plans, decides on ambiguities, accepts phases. Execution work is delegated to the subagents below, defined in `.claude/agents/*.md`.

### The team

| Agent | Role | Access | When it steps in |
|---|---|---|---|
| architect | reads the spec and the code, writes the phase plan, makes design decisions and records them as ADRs in Confluence | code read-only, Confluence write | at the start of every phase and on any architecture decision |
| dev-core | implements `src/core`, `src/daemon`, `src/cli` and their tests | code write, no push | engine, collection, DB, API tasks |
| dev-ui | implements `src/ui` (SPA, three.js scene, screens) starting from `design/mockup.html` | code write, no push | UI tasks |
| reviewer | reviews each task's diff using the checklist from the `review-checklist` skill; verdict approved / rework with a list of findings | code read-only | after every task, before the tester |
| tester | runs vitest, writes missing fixture tests, checks the UI with Playwright (Playwright Test for regressions, Playwright MCP for new features), opens a Jira Bug with video and trace attached on failure | code write only in `test/`, Jira write | after review, before the task is closed |

The team lead (main session) does: breaking the phase into Jira tasks, dispatching to dev-core / dev-ui in separate worktrees, moving tasks through states, commit and tag at the end of the phase, the phase report in Confluence.

Task flow: Jira task → architect (if a decision is needed) → dev-core or dev-ui in a worktree → reviewer → tester → the team lead merges, moves the task to Done and comments the summary on it.

### Guardrails

| Type | What it enforces |
|---|---|
| `CLAUDE.md` | the rules from sections 5, 3a and 10; one commit per logical step; zero secrets and personal paths; a single question on ambiguity |
| `.claude/settings.json` permissions | allow: `npm test`, `npm run lint`, `npm run build`, `git add/commit/tag`, `gh pr`; deny: `git push --force`, `rm -rf`, any command touching the real `~/.config/diffcity` in tests (tests use a temporary directory) |
| PreToolUse hook (Bash) | blocks the commands on the deny list and any write outside the repo |
| PostToolUse hook (Edit/Write) | runs `eslint --fix` and `tsc --noEmit` on the touched files; blocks the commit if errors appear |
| PreToolUse hook (Write) | rejects content that looks like secrets (token, key, password with a value) or real home paths |
| Stop hook | runs `npm test` and writes a 5-line summary; the session stops only with green tests or with an explanation of the failure |
| Worktrees | dev-core and dev-ui work in separate `git worktree`s under `.worktrees/` in the repo (gitignored, so they stay inside the write boundary), one per task; merge only through the team lead after reviewer and tester |

These guardrails apply only to developing diffcity itself. They do not restrict the product: once installed, `diffcity` runs from anywhere, on any repo.

### Skills (`.claude/skills/<name>/SKILL.md`)

| Skill | Contents |
|---|---|
| spec-rules | sections 5 and 3a as a verifiable checklist, with fixture examples for each rule |
| review-checklist | security, correctness, scope relative to the task, tests that assert, adherence to the `src/` structure, zero computation logic in the UI |
| three-scene | how the mockup scene is built (tokens, materials, badge sprites, orbit, raycast, filters) and how it maps onto `src/ui` |
| testing | fixture conventions, `playwright.config.ts` with `retain-on-failure` for video, trace and screenshot, how artefacts are attached to the Jira Bug |
| jira-flow | the project, epics per phase, task format (title, acceptance criteria, link to the spec section), states, branch naming `<KEY>-<nr>-<slug>`, commits with the task key |
| confluence-docs | the space structure and templates: ADR, phase report, runbook, scope decision |

### Jira

The project is created manually by the human (Jira Software, team-managed); the team lead then creates the structure through the Atlassian MCP:

| Epic | Contents |
|---|---|
| Phase 0: Setup | repo, tooling, CI, complete `.claude/` (agents, skills, hooks, settings, CLAUDE.md), Jira and Confluence structure |
| Phase 1: Semantic diff | tasks per rule from sections 5.1, 5.2, 5.3 and per fixture |
| Phase 2: Daemon and collection | tasks per CLI command, watcher, change list, Fleet and Repo screens, SSE |
| Phase 3: Change screen | 3D scene, hover, select, filters, live update |
| Phase 4: Reading and findings | execution path, panel, findings and SARIF import, slash command, Stop hook, session context, finding actions |
| Phase 5: Audit and export | audit, status, fleet map, HTML and PlantUML export, light theme, approve → integrate, README |
| Release | final name, npm publish, demo GIF, announcement |

Every task has acceptance criteria copied from the phase's definition of done or from the matching spec rule. Bugs created by the tester are linked to the parent task.

### Confluence

The space is created manually by the human (knowledge base type, named after the project); the team lead then creates the pages:

| Page | Contents | Maintained by |
|---|---|---|
| Overview | spec summary, links to repo, Jira, mockup | team lead |
| Architecture | parent page with ADRs, one per decision (context, options, decision, consequences) | architect |
| Agent team and workflow | the team above, the task flow, guardrails | team lead, in phase 0 |
| Phase reports | one page per phase, written at the tag: delivered, remaining, metrics (tests, findings, time) | team lead |
| Runbook | install, shell hook, daemon, troubleshooting | dev-core |
| Findings format | own format and SARIF mapping | dev-core |

---

## 11. Kickoff prompt for Claude Code

Paste the block below as the first message, with `SPEC.md` (this file) and `design/mockup.html` already in the project folder.

```
We are building diffcity, a local all-in-one visual code review app for code written by AI agents:
a daemon that watches every repo I work in, builds the list of changes (working tree, branches, PRs)
for each one on its own, and a browser UI where any change opens as a 3D city with review verdicts.
The full specification is in SPEC.md and is the source of truth.
The visual reference is design/mockup.html: the change screen must look and behave identically;
the Fleet and Repo screens use the same tokens and components.

You are the team lead. I am the PO: I approve plans, decide on ambiguities, accept phases.
You work with the agent team, guardrails and skills from section 10a of the spec,
and with Jira + Confluence through the Atlassian MCP. The Jira project key is DC (epics DC-1..DC-7 and the
phase 0 tasks DC-8..DC-15 already exist), the Confluence space key is DI.

Phase 0, in this order:
1. Read SPEC.md in full and design/mockup.html; extract from the mockup the tokens, fonts,
   interaction rules and the three.js scene for the three-scene skill and for src/ui.
2. Check availability of the name diffcity on npm and GitHub; if it is taken, propose 3 alternatives and wait.
3. Create the complete .claude/: agents (architect, dev-core, dev-ui, reviewer, tester), skills
   (spec-rules, review-checklist, three-scene, testing, jira-flow, confluence-docs), hooks, settings.json
   with permissions, and CLAUDE.md, exactly as section 10a describes. Show me each file before moving on.
4. Read epics DC-1..DC-7 and phase 0 tasks DC-8..DC-15 from Jira; create in Confluence
   the pages Overview, Architecture, Agent team and workflow, Phase reports, Runbook, Findings format.
5. Propose the folder structure and package.json; wait for my confirmation.
6. Implement phase 0 with the team: every task goes through architect (if needed) → dev → reviewer → tester,
   in separate worktrees, with the Jira task moved through states and commented at the end.
7. Stop at the phase 0 definition of done: green tests, diffcity --help works, a sample task has gone through the full flow.

Rules throughout:
- Before every phase: architect writes the plan and the fixture list, you create the phase's Jira tasks, I give the OK.
- Follow sections 5 (status, verdict, tier 1, path, findings import) and 3a (collection, dynamic list) exactly.
  Flag any deviation explicitly and record it as an ADR.
- All computation lives in src/core and runs in the daemon; the UI only renders, filters, selects.
- Public repo: zero personal paths, zero secrets, zero real client names in code, tests, fixtures, Jira or Confluence.
- Strict TypeScript, ESM, Node 22.13+, vitest, Vite for the UI, one commit per logical step, conventional commits with the task key.
- At the end of every phase: green tests, tag v0.<phase>.0, CHANGELOG.md and README.md updated,
  the phase report page in Confluence, the epic closed in Jira, and a 10-line summary for me.
- When something in the spec is ambiguous, ask a single precise question with your recommended option.
```

---

## 12. Backlog after v1

Java and PHP via tree-sitter; impact map on untouched code; GitLab and Bitbucket as PR sources; PUML class diagram; a GitHub Action that runs the engine in CI and attaches the HTML export to the PR; hosted dashboard with metadata sync (SARIF + symbol graph, no source code).

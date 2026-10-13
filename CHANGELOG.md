# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

Phase 4: execution-order reading and findings.

### Added

- The execution path: entry points (routes, controllers, `main`, package bins, CLI actions, jobs, tests), the steps in the order the code runs, SQL at the end, an Unconnected section, a `why` per step and its inline diff. The call graph covers the touched symbols, with ts-morph for TypeScript and name matching for JavaScript (SPEC 5.4, ADR-034).
- The reading panel shows the path in sections (Execution path, Migrations, Unconnected), with empty states.
- Findings: `diffcity import` takes the own format or SARIF, anchors each finding to a symbol, merges duplicates with their list of sources and marks a finding `fixed` when a later import no longer reports it. Findings are an overlay on the served Report; the stored Report does not change (SPEC 5.6, ADR-036).
- Finding actions in the panel: Ask agent to fix (the fix queue, `.diffcity/fix-queue/`), Mark as intended, Undo, with a live refresh.
- `diffcity setup-claude` installs the `/diffcity-review` command and the Stop and SessionEnd hooks for Claude Code; `--remove` takes out only what it wrote. `diff --json --compact` leaves out untouched files (SPEC 7, ADR-037).
- Approve in the top bar, unlocked when every touched tier 1 file has a current mark and checked again by the daemon. "Check the rest and approve" marks the listed tier 1 files and approves after one confirmation.
- Faster review: Needs rewrite (W) marks at once and the note is optional; a general note alone is a complete review; "Send to agent" in the top bar.
- Send review to the agent: the dialog shows the exact command and the full summary, and runs only after the summary is read and confirmed. It resumes the change's Claude Code session, off by default per repo (ADR-029).
- Session context: the Session tab shows each Claude Code session linked to the change, with prompts, questions and answers, the agents that ran, an activity summary and an "active" tag, with secrets redacted. Session data is never part of the Report; `diff --json --with-sessions` adds it on request (ADR-038).
- Review rules: the file-size rule and the layers rule on the import edges a change adds, as rule findings with X markers and rule chips; a rule that cannot run is shown as not checked, never as passed (ADR-030, ADR-031).
- Spec scope: a `.diffcity/spec.md` (or `diff --spec <file>`) puts every touched file in or outside the spec; a spec that names no touched symbol or file marks nothing and says so (SPEC 5.5, ADR-035).
- Every external tool runs through one hardened runner: no shell, an environment allow-list, git guards, timeouts and output caps (ADR-032).

### Changed

- The database schema goes from v2 to v6 (findings, sessions, optional rewrite notes, the rules key of each snapshot). An existing database is migrated on the first daemon start; an older diffcity refuses a newer database.
- Snapshots are recomputed after a restart when the rules or a trusted repo config changed while the daemon was stopped.
- Rule globs are matched without regular expressions, and each entry is capped at 1,024 characters.
- On macOS, a CLI carrying the `com.apple.provenance` attribute starts the daemon through LaunchServices (ADR-039).

### Fixed

- `diffcity start` refuses a port already held on 0.0.0.0, `::` or `::1`.
- The daemon handles SIGINT and SIGTERM while it is still loading.
- The palette keeps the result moved to across newer answers; the Vite dev proxy presents the dev page's origin to the daemon.

## [0.3.0] - 2026-10-04

Phase 3: the change screen.

### Added

- The change screen as a 3D city (the night data city): every file is a building, every symbol a floor, lots per package with the tier 1 outline, verdict outlines and tags, labels, orbit, zoom and R. Live updates move, raise and sink buildings without a reload and keep the camera, selection, filters and the open file view.
- Top bar counters, verdict, type and rule filter rows, legend, tooltip, selection card and rule check chips, as in the mockup.
- Effects: light beams, finding pins by severity and X markers for rule findings (open findings only), pulsing critical floors, the reading path, the breathing tier 1 outline; a static glow under reduced motion.
- Reading panel with Execution order, Findings, Outside the spec and Symbols tabs, J/K navigation, and the file view with the full diff from the daemon: line numbers, syntax highlighting, folded unchanged blocks, N / Shift+N through hunks, and states for binary, too large, unavailable and stale files.
- Review marks per file and per symbol (Checked, Looks good, Needs rewrite with a note and a line range), kept by the daemon, outdated when the marked code changes, with progress in the top bar, a "Hide checked" filter and a review summary with Copy.
- `GET /api/changes/:id/diff` and the review routes (`/api/changes/:id/review`), with a write guard on every non-GET request.
- Accessibility: a review path without WebGL (touched files by package, opening the file view), `[` / `]` between buildings, a focus ring on everything Tab reaches, a screen-reader summary and live selection announcements, WCAG AA text contrast.
- Large repositories: at most 40 draw calls and 120 labels at any city size, one quality level chosen at mount from a frame-rate probe, in-place updates of the city's buffers.
- A standalone harness that mounts the change screen from a Report embedded in an HTML file.
- The Repo screen toggle shows the number of closed changes.

### Changed

- Code files larger than 2 MiB are not parsed: they are treated as non-code files (status from git, no symbols). A whitespace- or comment-only change to such a file is `mod` (SPEC 5.1, ADR-033).
- The Fleet map is drawn with flat shapes, so its first paint no longer stalls browsers without GPU acceleration.
- Repo notes in the API are `{ code, text }` objects.
- Snapshots store their merge-base and content fingerprints (database schema v2).

## [0.2.0] - 2026-10-03

Phase 2: the daemon and collection.

### Added

- The daemon: one instance per `DIFFCITY_HOME`, a local socket and an HTTP server on 127.0.0.1 with server-sent events. `diffcity start [<dir>]` and `diffcity stop` are the entry points; `up`, `track`, `scan`, `shell-init` and `trust` complete the CLI.
- A SQLite database through `node:sqlite` (no native build), with the change list (Drafts, branches, PRs), snapshots and a 90-day archive of closed changes.
- Collection in worker threads, triggered by the shell hook, file watchers on git paths and working trees, `gh` polling every 15 minutes, `scan` and daemon start; repos not entered for 7 days become inactive.
- The shell hook for zsh, bash and fish.
- `diffcity trust`: a repo's `diffcity.config.js` is loaded by the daemon only for trusted repos.
- The web UI served by the daemon: app shell, Fleet screen and Repo screen with the live change list.
- git runs with the repository's filters, hooks, textconv, external diff, fsmonitor and pager disabled.

## [0.1.0] - 2026-10-01

Phase 1: semantic diff for TypeScript and JavaScript.

### Added

- `diffcity diff [--json] [--base <ref>] [--head <ref>]`: the semantic diff of the current change as a `Report` (SPEC 4.1), or a short text summary. Runs in-process, without the daemon.
- Base detection: `--base`, `base` in `diffcity.config.js`, `main`, `master`, then the default branch from `gh`. The diff is taken against the merge-base; without `--head` the working tree is compared, including untracked files.
- `diffcity.config.js` with `base` and `tier1` (a list that replaces the defaults, or a function that changes them).
- Symbol extraction for TS, TSX and JS with web-tree-sitter (wasm grammars shipped in `grammars/`, no native build) and for SQL migrations.
- Symbol status (`add`, `del`, `sig`, `mod`, `same`) and file status per SPEC 5.1: whitespace and comment changes are ignored, directive comments are not, and files without changed symbols take their status from git.
- Tier 1 zones and the file verdict per SPEC 5.2 and 5.3.
- Rename detection, including plain `mv` that was not staged, without writing to the repository's index.

### Changed

- `npm run build` cleans `dist/` first.

## [0.0.0] - 2026-09-30

Phase 0: project setup.

### Added

- `diffcity` CLI with every command from the specification registered; `--help` lists them, and commands not implemented yet exit with status 2.
- `diffcity --version` / `-V`, read from `package.json` at runtime.
- TypeScript (strict, ESM) package targeting Node.js 22.13+, with eslint, vitest and a GitHub Actions workflow on Node 22 and 24.
- Specification (`SPEC.md`), visual reference (`design/mockup.html`), findings format (`docs/findings.md`).
- Claude Code setup for the project: agent team, skills, guardrail hooks and permissions (`.claude/`, `CLAUDE.md`, `docs/guardrails.md`).

[0.3.0]: https://github.com/kidex/diffcity/releases/tag/v0.3.0
[0.2.0]: https://github.com/kidex/diffcity/releases/tag/v0.2.0
[0.1.0]: https://github.com/kidex/diffcity/releases/tag/v0.1.0
[0.0.0]: https://github.com/kidex/diffcity/releases/tag/v0.0.0

# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

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

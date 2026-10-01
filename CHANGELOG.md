# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

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

[0.1.0]: https://github.com/kidex/diffcity/releases/tag/v0.1.0
[0.0.0]: https://github.com/kidex/diffcity/releases/tag/v0.0.0

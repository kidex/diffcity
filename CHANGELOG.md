# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [0.0.0] - 2026-09-30

Phase 0: project setup.

### Added

- `diffcity` CLI with every command from the specification registered; `--help` lists them, and commands not implemented yet exit with status 2.
- `diffcity --version` / `-V`, read from `package.json` at runtime.
- TypeScript (strict, ESM) package targeting Node.js 22.13+, with eslint, vitest and a GitHub Actions workflow on Node 22 and 24.
- Specification (`SPEC.md`), visual reference (`design/mockup.html`), findings format (`docs/findings.md`).
- Claude Code setup for the project: agent team, skills, guardrail hooks and permissions (`.claude/`, `CLAUDE.md`, `docs/guardrails.md`).

[0.0.0]: https://github.com/kidex/diffcity/releases/tag/v0.0.0

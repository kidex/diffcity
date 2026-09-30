---
name: spec-rules
description: Verifiable checklist for diffcity's core rules - symbol status, file verdict, tier 1 zones, execution path, spec scope, findings import (SPEC.md section 5) and automatic collection and the dynamic change list (section 3a) - with the fixture that proves each case. Use when implementing, reviewing or testing any of these rules.
---

# Spec rules

SPEC.md sections 5 and 3a are implemented exactly. Each line below is one behaviour with the fixture that proves it. A rule is done when every fixture in its table has a passing test. Any deviation needs PO approval and an ADR.

Fixtures live in `test/fixtures/<area>/<case>/` and use invented names only.

## 5.1 Symbol status

| # | Behaviour | Fixture |
|---|---|---|
| S1 | Symbol only in after → `add` | `status/add-function` |
| S2 | Symbol only in before → `del` | `status/del-function` |
| S3 | Same name, parameter added/removed/retyped, or return type changed → `sig` | `status/sig-param-added`, `status/sig-param-retyped`, `status/sig-return-changed` |
| S4 | Same name and signature, body changed → `mod` | `status/mod-body` |
| S5 | Identical → `same` | `status/same` |
| S6 | Whitespace or comment-only change inside the body → decide with the PO (default: `same`) and record it | `status/whitespace-only` |
| S7 | File status = heaviest symbol status, order `sig > add > del > mod > same` | `status/file-mixed` (one `add` + one `sig` → `sig`) |
| S8 | New file → every symbol `add` | `status/new-file` |
| S9 | Deleted file → every symbol `del` | `status/deleted-file` |
| S10 | Symbol kinds covered: class, function, method, export, sql | one fixture per kind under `status/kind-*` |

## 5.2 File verdict

Evaluated in this order; the first match wins.

| # | Behaviour | Fixture |
|---|---|---|
| V1 | Tier 1 path → `eyes`, even with a high finding | `verdict/tier1-with-high-finding` |
| V2 | At least one `sig` symbol → `eyes` | `verdict/sig-outside-tier1` |
| V3 | Open high finding, not tier 1, no `sig` → `risky` | `verdict/high-finding` |
| V4 | High finding with state `intended` or `fixed` does not count | `verdict/high-finding-intended` → `ok` |
| V5 | `inSpec === false` → `spec` | `verdict/outside-spec` |
| V6 | `inSpec === null` never yields `spec` | `verdict/no-spec-file` → `ok` |
| V7 | Touched, nothing above → `ok` | `verdict/touched-clean` |
| V8 | Zero changes → `same` | `verdict/untouched` |

## 5.3 Tier 1 zones

| # | Behaviour | Fixture |
|---|---|---|
| T1 | Path containing any of `auth`, `guard`, `security`, `session`, `payment`, `billing`, `migration`, `schema`, `infra`, `k8s`, `terraform`, `Dockerfile`, `.env`, `secrets` is tier 1 | table-driven unit test over all 14 tokens |
| T2 | Matching is on the path, not the file content | `tier1/content-mentions-auth` → not tier 1 |
| T3 | `diffcity.config.js` overrides the default list | `tier1/config-override` |
| T4 | A package is tier 1 when its path matches (drives the orange outline) | `tier1/package-path` |

Decide with the PO before implementing: case sensitivity and whether `authorized-users.md` matches `auth` (substring vs segment). Default recommendation: case-insensitive substring, as the spec literally says "contains".

## 5.4 Execution path

| # | Behaviour | Fixture |
|---|---|---|
| P1 | Entry points ordered: HTTP routes new/modified, controller handlers, `main`/CLI entry, scheduled jobs, new tests | `path/entry-priority` |
| P2 | BFS from each entry over the call graph, restricted to touched symbols | `path/bfs-touched-only` |
| P3 | TS calls resolved with ts-morph; JS calls with tree-sitter + name matching | `path/ts-resolution`, `path/js-name-match` |
| P4 | Touched SQL migrations go last, after the last repo/DB symbol | `path/migration-last` |
| P5 | Touched symbols on no path form "Unconnected" at the end | `path/unconnected` |
| P6 | `why` from rules: new endpoint, signature changed with N call sites, schema modified | `path/why-rules` |
| P7 | A finding can override `why` | `path/why-override` |

## 5.5 Spec scope

| # | Behaviour | Fixture |
|---|---|---|
| X1 | `.diffcity/spec.md` present: touched files with no link to symbols on spec-rooted paths → `inSpec: false` | `spec/unrelated-file` |
| X2 | `--spec <file>` behaves like `.diffcity/spec.md` | `spec/cli-arg` |
| X3 | No spec → `inSpec: null` everywhere, `spec` verdict disabled | `spec/absent` |

## 5.6 Findings import

| # | Behaviour | Fixture |
|---|---|---|
| F1 | Own format: array of `Finding` without `symbolId` | `findings/own-format.json` |
| F2 | SARIF 2.1: `ruleId → title`, `level → severity`, `physicalLocation → file/line`, `tool.driver.name → source` | `findings/semgrep.sarif.json`, `findings/eslint.sarif.json` |
| F3 | SARIF `level` mapping: `error → high`, `warning → med`, `note`/`none` → `low` (confirm with PO) | same fixtures |
| F4 | Line anchored to the symbol whose `range` contains it, in the `after` version | `findings/anchor-inside` |
| F5 | Line outside every symbol → file-level finding, `symbolId` absent | `findings/anchor-file-level` |
| F6 | Dedup: same `symbolId` + `category` + normalized title → one entry listing all sources | `findings/dedup-two-sources` |

## 3a Collection

| # | Behaviour | Fixture / test |
|---|---|---|
| C1 | Shell hook on `cd` into a folder with `.git` runs `track` in under 50 ms; the rest is async | timing test on `track` with a stubbed socket |
| C2 | `track` registers a missing repo and asks the daemon to collect; starts the daemon if absent | integration test with a temp config dir |
| C3 | `track --agent` marks the change "agent worked, not reviewed" and writes an `agent` event (ADR-001) | integration test |
| C4 | Watcher on `.git/refs`, `.git/HEAD` and the working tree; 2 s debounce; recompute only the affected change | fake timers + temp repo |
| C5 | `gh pr list --json` every 15 min per active repo, only if `gh` is installed and authenticated | stubbed `gh` |

## 3a Change list

| # | Behaviour | Fixture / test |
|---|---|---|
| L1 | Draft from `git status --porcelain` with uncommitted changes | temp repo with a dirty tree |
| L2 | Branch from `git for-each-ref` with commits ahead of the base | temp repo with a branch |
| L3 | PR from `gh pr list` (or remote branch with PR) | stubbed `gh` |
| L4 | Deduplicated on `head` (a branch with an open PR appears once, as PR) | temp repo + stubbed `gh` |
| L5 | Base detection: `main`, then `master`, then `gh` default branch; overridable in config | three temp repos |
| L6 | Each change carries title, ahead/behind, files and symbols by status, aggregated verdicts, review state, last event and time | snapshot test on the change record |
| L7 | Merged or deleted changes move to the archive and stay viewable 90 days | fake clock |

## Fixture helpers

Git-based fixtures are built at test time in a temp directory by a helper (`test/helpers/repo.ts`): write `before/` files, commit, write `after/` files, commit or leave dirty. Never commit a nested `.git` directory.

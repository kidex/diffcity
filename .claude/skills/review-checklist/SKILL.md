---
name: review-checklist
description: The checklist the diffcity reviewer applies to every task diff - security, correctness, scope against the Jira task, tests that assert, src/ layout, no computation in the UI, public-repo hygiene. Use when reviewing a task before it goes to the tester.
---

# Review checklist

Go through every section. A finding needs a file, a line, and a concrete scenario where it fails; otherwise it is a note, not a finding.

## 1. Scope

- [ ] Every change serves an acceptance criterion of the task. Anything else is either removed or reported as out of scope.
- [ ] No drive-by refactors, renamed public APIs or reformatted files outside the task.
- [ ] Rules from SPEC.md section 5 or 3a match the `spec-rules` checklist exactly; any deviation has an accepted ADR.

## 2. Correctness

- [ ] Errors are handled at the boundary where they can be acted on (git failures, missing `gh`, unreadable files, parse errors on one file must not kill the whole report).
- [ ] Edge cases: empty diff, binary files, renamed files, files with syntax errors, very large files, detached HEAD, repo without commits.
- [ ] Async code: no unhandled promise, no race between watcher events and collection (debounce respected).
- [ ] Paths are handled with `path`/`URL`, not string concatenation; works on macOS and Linux.
- [ ] SQLite access is in transactions where several writes belong together.

## 3. Security

- [ ] The daemon binds to `127.0.0.1` only.
- [ ] Every API input is validated (repo ids, change ids, paths); no path traversal from a request into the filesystem.
- [ ] Shell commands use `execFile`/`spawn` with argument arrays, never string interpolation into a shell.
- [ ] Rendered text from diffs, findings or commit messages is escaped in the UI (no `innerHTML` with untrusted strings).
- [ ] No secrets, tokens or real home paths anywhere in the diff.

## 4. Architecture

- [ ] Computation (status, verdict, path, anchoring, dedup) lives only in `src/core`.
- [ ] `src/ui` only renders a `Report`: no rule logic, no git, no parsing. The change screen works from a `Report` alone (ADR-002).
- [ ] `src/daemon` and `src/cli` call into `src/core` instead of reimplementing it.
- [ ] Slow collection work runs in a worker thread.
- [ ] New dependencies are justified, pinned, and installable without a native build.

## 5. Tests

- [ ] Every acceptance criterion has a test that fails without the change.
- [ ] Tests assert outcomes (statuses, verdicts, rows, rendered state), not just that code ran without throwing.
- [ ] Fixtures are small, named after what they prove, and use invented names.
- [ ] Tests use a temp directory, never the real `~/.config/diffcity`.
- [ ] No snapshot tests over large outputs without a targeted assertion next to them.

## 6. Hygiene

- [ ] Strict TypeScript: no unexplained `any`, no `@ts-ignore` without a reason.
- [ ] Commits are conventional, carry the task key, one logical step each, no AI attribution.
- [ ] Everything committed is in English; README and docs describe, they do not plan.

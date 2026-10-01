---
name: testing
description: diffcity testing conventions - vitest layout, fixture and temp-repo helpers, Playwright Test config with video/trace/screenshot retained on failure, Playwright MCP for exploring new UI, and how failure artefacts get attached to a Jira Bug. Use when writing or running tests, or reporting a test failure.
---

# Testing

## Layout

```
test/
  unit/            # src/core rules, one file per rule area (status, verdict, tier1, path, spec, findings)
  integration/     # CLI + daemon against temp repos and a temp config dir
  e2e/             # Playwright Test specs for the UI
  fixtures/        # small, invented inputs, named after what they prove
  helpers/         # repo.ts (temp git repos), config.ts (temp config dir), report.ts (sample Report)
  playwright.config.ts
```

## Vitest

- `npm test` runs vitest over `test/unit` and `test/integration`.
- One `describe` per rule, one `it` per case from the `spec-rules` checklist, named with its id: `it('S3 sig: parameter added', ...)`.
- Assert the outcome precisely (`expect(file.status).toBe('sig')`), not just the absence of errors.
- Anything that needs a config or DB gets a fresh temp dir from `helpers/config.ts`; `DIFFCITY_HOME` points there. The real `~/.config/diffcity` is never touched.
- Git fixtures are built at test time by `helpers/repo.ts` in `os.tmpdir()`: commit `before/`, then apply `after/`. Never commit a nested `.git`.
- Timers (debounce, 15-minute PR poll, 90-day archive) use `vi.useFakeTimers()`.
- External tools (`gh`, `semgrep`, `gitleaks`, `npm audit`) are stubbed through an injected runner, never called for real in tests.

## Playwright Test (regressions)

`test/playwright.config.ts` defines two projects (ADR-023):

| Project | Specs | Server | Purpose |
|---|---|---|---|
| `screens` | `test/e2e/screens/**` | `test/e2e/support/stub-server.mjs`: serves `dist/ui`, holds a real SSE stream, answers `/api/*` from `test/fixtures/ui/`; specs may also mock routes with `page.route` | screen behaviour against fixed data, no daemon |
| `acceptance` | `test/e2e/acceptance/**` | the real daemon: `node dist/cli/index.js up --foreground --no-open --port <free>` with a temporary `DIFFCITY_HOME` | end-to-end proof (for example `cd` → UI in 5 s) |

`up` detaches unless `--foreground` is passed, so a web server command must always use `--foreground`. Video, trace and screenshot are kept on failure; CI retries once.

Run with `npm run test:e2e`. Artefacts land in `test-results/<test>/` (`video.webm`, `trace.zip`, `test-failed-1.png`). `test-results/` is gitignored.

Locally, when Playwright's Chromium cannot be downloaded, use the installed Chrome without video: `DIFFCITY_E2E_CHANNEL=chrome DIFFCITY_E2E_VIDEO=off npm run test:e2e`. CI sets neither and uses the downloaded Chromium with video. `DIFFCITY_E2E_SKIP_BUILD=1` skips the build in the global setup.

Under load, git-heavy vitest suites can hit the 30 s timeouts. Run `npx vitest run --maxWorkers=2` when other agents are testing in parallel, and rerun a timed-out file alone before calling it a failure.

Scene tests assert through state the UI exposes for tests (a `data-state` attribute on the city container with the selected building, active filters and hovered id), not by reading pixels. Visual parity with the mockup is checked with screenshots compared by eye and attached to the task.

## Playwright MCP (new features)

The `playwright` MCP server (`.mcp.json`) drives a browser interactively: navigate, click, hover, take snapshots and screenshots into `test-results/mcp/`. Use it to explore a new screen against `design/mockup.html`, then encode what you verified as a Playwright Test spec so it becomes a regression test. The MCP session is not the proof; the spec is.

## Reporting a failure in Jira

1. Create a `Bug` in project `DC` (in English): summary, steps to reproduce, expected vs actual, failing test name, commit hash, and the artefact paths.
2. Link it to the task with `createIssueLink`, type `Relates`.
3. Attach the artefacts. The Atlassian MCP has no attachment upload, so use the Jira REST API with credentials from the environment (never written to a file):

   ```sh
   curl -sS -X POST \
     -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
     -H "X-Atlassian-Token: no-check" \
     -F "file=@test-results/<test>/video.webm" \
     -F "file=@test-results/<test>/trace.zip" \
     "$JIRA_BASE_URL/rest/api/3/issue/DC-<nr>/attachments"
   ```

   If `JIRA_EMAIL`, `JIRA_API_TOKEN` or `JIRA_BASE_URL` is not set, do not ask for them: list the artefact paths in the Bug and tell the team lead that attachments are pending.
4. Report the Bug key back to the team lead.

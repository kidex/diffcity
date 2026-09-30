# Golden change scenarios

Each directory here is one realistic change in an invented repo. `test/integration/golden-scenarios.test.ts` builds it as a temporary git repo, runs the built `diffcity diff --json` in it and compares the output with `expected.json` byte for byte.

| Scenario | Repo | What it covers |
|---|---|---|
| `order-discounts` | `shopfront` | the change in `design/mockup.html`: `sig` on a tier 1 guard, a new SQL migration, a new file, a deleted function, a new test, untouched files in touched packages, a whole untouched package |
| `session-refresh` | `ledger` | working-tree mode (staged, unstaged, untracked), tier 1 on `session`, a renamed and modified file, a deleted file, a reformat-only file (`same`), a JS file, a modified `Dockerfile` |
| `report-cli-command` | `acme-cli` | a new command in TS and TSX, a `master` base with no `main` that moved on after the fork, `tier1` overridden in `diffcity.config.js`, import-only changes, overloads, `export { }` |

## Layout

- `base/`: the initial tree, committed on the base branch.
- `steps.json`: what happens on top of it (read by `test/helpers/scenario.ts`):
  - `repo`: the repo name. The temp working tree gets this name, so it is `meta.repo`.
  - `base`, `branch`: the base branch and the feature branch.
  - `now`: ISO 8601 time passed to the CLI as `DIFFCITY_NOW`; it becomes `meta.generatedAt`.
  - `commits`: commits on the feature branch, in order.
  - `baseCommits` (optional): commits on the base branch after the feature branch forked.
  - `uncommitted` (optional): changes left in the working tree; the paths in `stage` are staged.

  Each commit or uncommitted state can have `rename` (old path to new path, content kept), `delete` (paths) and `files` (an overlay directory in the scenario, whose files are written over the tree). They are applied in that order.
- `expected.json`: the golden Report.

## Regenerating

```sh
UPDATE_GOLDEN=1 npm test
```

This rewrites every `expected.json` from the current CLI output. The hand-written tables in `test/integration/golden-review.ts` are not regenerated, so a golden that breaks a rule still fails the test. Review every changed `expected.json` against SPEC.md sections 5.1 to 5.3 before committing it.

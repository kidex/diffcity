# diffcity

[![CI](https://github.com/kidex/diffcity/actions/workflows/ci.yml/badge.svg)](https://github.com/kidex/diffcity/actions/workflows/ci.yml)

Local visual code review for code written by AI agents.

diffcity runs as a daemon on your machine, watches the repos you work in, and builds the list of changes in each one: the working tree, local branches and open pull requests. Any change opens as a 3D city. Every package is a lot, every file a building, every function a floor, and the review verdict floats above every touched building. A side panel reads the change in the order the code runs, with findings from Claude, semgrep or eslint anchored to the symbols they concern.

The goal is to understand in a few minutes what an agent built, where the risk is, and what deserves a manual read.

## Requirements

- Node.js 22.13 or later
- git
- Optional: `gh` (authenticated) for open pull requests; `semgrep` and `gitleaks` for audits

## Getting started

```sh
npm i -g diffcity
diffcity start
diffcity stop
```

`diffcity start` starts the daemon if it is not running, registers the repo you are in (or the one given as `diffcity start <dir>`) and opens it in the browser. Run outside a repo, it opens the Fleet of every registered repo. `diffcity stop` stops the daemon.

## Commands

| Command | What it does |
|---|---|
| `diffcity start [<dir>] [--port 4321] [--no-open]` | start the daemon if needed and open the repo at `<dir>` (or the current repo) in the browser |
| `diffcity stop` | stop the daemon |
| `diffcity up [--port 4321]` | start the daemon and open the UI on localhost |
| `diffcity trust [<dir>] [--list] [--remove]` | let the daemon load a repo's `diffcity.config.js`, which runs code; untrusted repos use the defaults |
| `diffcity shell-init [zsh\|bash\|fish]` | print the shell hook that registers a repo when you `cd` into it |
| `diffcity track [<dir>] [--agent]` | register a repo and ask the daemon to collect its changes |
| `diffcity scan <dir>` | discover and register every repo under a folder |
| `diffcity diff --json [--base] [--head]` | semantic diff of the current change |
| `diffcity import <file> [--open]` | anchor findings (own JSON or SARIF) to symbols of the current change |
| `diffcity export html\|puml [--out]` | self-contained export of the current change |
| `diffcity status` | repos ordered by urgency |
| `diffcity audit [--stale] [<repo>]` | full audit: dependencies, semgrep, gitleaks, AI review on tier 1 |
| `diffcity --version` | print the installed version |

`import`, `export`, `status` and `audit` are not implemented yet and exit with status 2.

### Semantic diff

```sh
diffcity diff            # summary of the current change against the detected base
diffcity diff --json     # the full report: packages, files, symbols, statuses, verdicts
```

The base is `--base`, then `base` in `diffcity.config.js`, then `main`, `master` or the default branch reported by `gh`. Without `--head`, the working tree is compared, including untracked files. An optional `diffcity.config.js` at the repository root sets `base` and the tier 1 path tokens:

```js
export default {
  base: 'develop',
  tier1: (defaults) => [...defaults, 'release'],
};
```

## Development

```sh
npm install
npm test          # vitest
npm run lint      # eslint
npm run typecheck # tsc --noEmit
npm run build     # compile to dist/
node dist/cli/index.js --help
```

| Path | Contents |
|---|---|
| `src/cli/` | command-line entry point |
| `src/daemon/` | local server, API, SSE, watcher, collector, scheduler |
| `src/core/` | git, parsing, semantic diff, verdicts, execution path, findings, database |
| `src/ui/` | browser UI: fleet, repo and change screens, 3D scene |
| `test/` | unit and integration tests, fixtures |
| `design/mockup.html` | visual reference for the change screen |
| `docs/findings.md` | findings import format and SARIF mapping |
| `docs/guardrails.md` | hooks that guard Claude Code sessions on this repo |
| `SPEC.md` | full specification |

All computation lives in `src/core` and runs in the daemon; the UI only renders a ready-made report.

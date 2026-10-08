# Claude Code integration

`diffcity setup-claude` connects Claude Code to diffcity with two files: the `/diffcity-review` slash command and a Stop hook. After it, `/diffcity-review` in a Claude Code session reviews the current change and puts the findings on the city, and every finished agent task marks the change as "agent worked, not reviewed".

```sh
diffcity setup-claude                 # the user's Claude Code configuration
diffcity setup-claude --repo          # this repo's .claude/ instead (or --repo <dir>)
diffcity setup-claude --dry-run       # print what would change, write nothing
diffcity setup-claude --remove        # remove only what diffcity wrote
```

## What it writes

| File | Content |
|---|---|
| `<config>/commands/diffcity-review.md` | the `/diffcity-review` command (SPEC.md section 7.1) |
| `<config>/settings.json` | one Stop hook entry, merged into the existing settings (SPEC.md section 7.2) |
| `<config>/settings.json.diffcity-backup` | a copy of `settings.json` from before diffcity first changed it, written once |

`<config>` is `$CLAUDE_CONFIG_DIR` when it is set (it must be an absolute path), `~/.claude` otherwise, or `<repo>/.claude` with `--repo`. setup writes nothing else, and no diffcity settings.

The command prints each file it wrote (or would write), the hook command it chose and the Claude Code version the files were checked against. It exits 0 on success and 1 on a refusal, with the reason on stderr; a refusal writes neither file. A write that fails half way, for example on a read-only directory, can leave one file written and not the other; running setup again once the directory is writable completes it.

## The hook command

The Stop hook and the slash command call the CLI the same way:

- `diffcity track --agent` when the `diffcity` found on the `PATH` is the CLI running setup from a global install (`npm i -g diffcity`), not a `node_modules/.bin` copy: `PATH` entries ending in `node_modules/.bin` are skipped, and a run under `npx` or `npm exec` (`npm_command=exec`) is never global, because the Claude Code session does not have their `PATH`;
- otherwise `"<absolute node>" "<absolute dist/cli/index.js>" track --agent`, the node binary and the CLI that ran setup. A path containing `"`, `$`, `` ` ``, `\`, `(`, `)`, `: `, ` #` or a control character is refused: install diffcity globally instead.

The absolute form holds paths of your machine. With `--repo` setup warns about it: do not commit those files, or install diffcity globally and run setup again.

The hook never blocks the agent: on any failure it prints one line on stderr and exits 0. It never opens the browser.

## settings.json

- The file is parsed as JSON. A file that is not JSON, is not an object, or has a `hooks` that is not an object or a `hooks.Stop` that is not an array is refused, never rewritten. A missing or blank file counts as `{}`.
- `{ "matcher": "", "hooks": [{ "type": "command", "command": "<hook command>" }] }` is appended to `hooks.Stop`, unless a hook with the identical command is already there. When diffcity's command file records another invocation (setup ran before from another install), the hook of that invocation is removed first and setup prints `replaced the Stop hook`. Every other key and hook is kept; the file is written back as two-space JSON.
- The new file is written to a temporary file in the same directory and renamed into place, keeping the file's mode. A `settings.json` that is a symbolic link is written at its target, so the link stays. A dangling link (its target does not exist) is replaced by a regular file.

## The command file

The command is called `/diffcity-review`, not `/code-review`, so it never shadows Claude Code's bundled `code-review` skill. Its frontmatter sets `disable-model-invocation: true`: only the user starts it, never the model, so the browser opens only when the user asked for the review.

The file starts with its frontmatter (`description`, `argument-hint`, `disable-model-invocation`, `allowed-tools`); the line right after the closing `---` is the marker `<!-- diffcity: diffcity-review v1 -->`. setup overwrites or removes the file only when that line is exactly the marker; any other `diffcity-review.md` is refused on install and kept on `--remove`.

`allowed-tools` is a YAML list, one rule per item, and allows exactly what the command runs: `Bash(<cli> diff:*)` and `Bash(<cli> import:*)` with the hook command's invocation, the two fix-queue commands `mv .diffcity/fix-queue .diffcity/fix-queue.taking` and `rm -r .diffcity/fix-queue.taking` as exact rules, `Glob` to list the taken item files, `Read` to read them, and `Write(.diffcity/findings.json)`. Fixing code from the fix queue goes through Claude Code's usual permission prompts.

The command's paths (`.diffcity/...`) are relative to the repository root, and the body says so: its commands run from the root, so start the Claude Code session there.

The command:

1. takes the fix queue by renaming the directory `.diffcity/fix-queue` to `.diffcity/fix-queue.taking`, reads every item file in it (one version 1 item per `.json` file), applies the items and removes the taken directory, so an item diffcity queues meanwhile lands in a new queue and is neither lost nor applied twice; a taking directory left by an interrupted run is applied and removed first. Claude Code's Glob lists at most 100 files, so the queue holds at most 100 items; if Glob still reports files it did not list, the command reads the items one hex prefix at a time (`0*.json` through `f*.json`) and removes the taken directory only after every item has been read;
2. reads `diffcity diff --json --compact`, the Report without untouched files;
3. writes the findings to `.diffcity/findings.json` in the format of [findings.md](findings.md), only for files of the change and lines of their current version;
4. runs `diffcity import .diffcity/findings.json --open`, which opens the change in the browser.

## --remove

`--remove` deletes the command file when it carries the marker, and a leftover `commands/code-review.md` (the command's first name) only when it carries the old marker `<!-- diffcity: code-review v1 -->`; any other `code-review.md` is never touched. It removes every Stop hook whose command is the current hook command or the one recorded in one of those command files. A Stop entry, `hooks.Stop` or `hooks` left empty by that is removed too; every other key and hook stays. `--remove` writes no backup. When `settings.json` is `{}` after that and there is no `settings.json.diffcity-backup`, diffcity created the file (setup backs up a `settings.json` that existed before it), so it is deleted. The `commands/` directory is removed when nothing is left in it; whether diffcity created it cannot be told, so an empty one is always removed.

## Claude Code version

The frontmatter keys, the `allowed-tools` rule syntax and the settings hooks format belong to Claude Code, not to diffcity. The files were checked against Claude Code 2.1.288.

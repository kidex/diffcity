# Guardrails

Claude Code sessions on this repo run under the hooks in `.claude/hooks/`, wired in `.claude/settings.json`. They apply only to developing diffcity, not to the installed tool.

| Hook | Event | Enforces |
|---|---|---|
| `guard-bash.sh` | PreToolUse, Bash | no force push, no `rm -rf`, no access to the real `~/.config/diffcity`, no redirection or `tee` into paths outside the repo, no commit while lint or typecheck fails |
| `guard-write.sh` | PreToolUse, Write/Edit/MultiEdit | no file written outside the repo; no content containing the current home path, user name path, or secret-looking values |
| `post-edit.sh` | PostToolUse, Write/Edit/MultiEdit | `eslint --fix` on the touched file and `tsc --noEmit` on its package; errors are fed back to Claude |
| `stop-tests.sh` | Stop | runs `npm test`; green prints a short summary, red sends Claude back once to fix or explain |

Allowed write locations outside the repo: the system temp directories and Claude Code's per-project memory directory.

A blocked call exits with status 2 and a `BLOCKED by <hook>: <reason>` message on stderr, which Claude sees.

## Manual checks

Run from the repo root. Each check pipes a tool-call payload into a hook and prints the exit code. Fake secrets are built at run time so this file itself passes `guard-write.sh`. Inside a Claude Code session, put the checks in a script file and run the file: `guard-bash.sh` inspects the command text, so an inline `git push --force` test string is itself blocked.

```sh
export CLAUDE_PROJECT_DIR="$PWD"
bash_call() { jq -nc --arg c "$1" '{tool_input:{command:$c}}'; }
write_call() { jq -nc --arg f "$1" --arg c "$2" '{tool_input:{file_path:$f,content:$c}}'; }
check() { "$@" >/dev/null 2>&1; echo "exit=$?"; }
fake=$(printf 'a%.0s' {1..36})
```

| Check | Command | Expected |
|---|---|---|
| Force push refused | `bash_call 'git push --force origin main' \| check .claude/hooks/guard-bash.sh` | `exit=2` |
| Normal push passes the hook | `bash_call 'git push origin main' \| check .claude/hooks/guard-bash.sh` | `exit=0` |
| `rm -rf` refused | `bash_call 'rm -rf dist' \| check .claude/hooks/guard-bash.sh` | `exit=2` |
| Single-file `rm` allowed | `bash_call 'rm dist/a.js' \| check .claude/hooks/guard-bash.sh` | `exit=0` |
| Redirect outside the repo refused | `bash_call 'echo hi > ~/x.txt' \| check .claude/hooks/guard-bash.sh` | `exit=2` |
| `tee` outside the repo refused | `bash_call 'echo hi \| tee /etc/hosts' \| check .claude/hooks/guard-bash.sh` | `exit=2` |
| Redirect inside the repo allowed | `bash_call 'echo hi > out.txt' \| check .claude/hooks/guard-bash.sh` | `exit=0` |
| Real config dir refused | `bash_call 'ls ~/.config/diffcity' \| check .claude/hooks/guard-bash.sh` | `exit=2` |
| Write outside the repo refused | `write_call /etc/x a \| check .claude/hooks/guard-write.sh` | `exit=2` |
| Write inside the repo allowed | `write_call "$PWD/src/a.ts" 'const a = 1' \| check .claude/hooks/guard-write.sh` | `exit=0` |
| Real home path refused | `write_call "$PWD/a.ts" "const p = '$HOME/x'" \| check .claude/hooks/guard-write.sh` | `exit=2` |
| Fake GitHub token refused | `write_call "$PWD/a.ts" "const t = 'ghp_$fake'" \| check .claude/hooks/guard-write.sh` | `exit=2` |
| Password with a value refused | `write_call "$PWD/a.ts" "password: \"$fake\"" \| check .claude/hooks/guard-write.sh` | `exit=2` |
| Short placeholder allowed | `write_call "$PWD/a.ts" 'token: "test"' \| check .claude/hooks/guard-write.sh` | `exit=0` |
| Stop without a package is a no-op | `echo '{"stop_hook_active":false}' \| check .claude/hooks/stop-tests.sh` | `exit=0` |
| Stop with red tests sends Claude back | break a test, then `echo '{"stop_hook_active":false}' \| check .claude/hooks/stop-tests.sh` | `exit=2` |
| Stop after an explanation lets the session end | `echo '{"stop_hook_active":true}' \| check .claude/hooks/stop-tests.sh` | `exit=0` |
| Stop with green tests prints the summary | `echo '{"stop_hook_active":false}' \| .claude/hooks/stop-tests.sh` | JSON with `systemMessage` starting `npm test: green` |

The permission rules in `.claude/settings.json` deny the same destructive commands independently of the hooks, so either layer alone blocks them.

## Limits

- Redirect detection in `guard-bash.sh` is a heuristic over the command text. A script that writes files itself is not inspected.
- Secret detection is pattern-based. It catches common token formats and `key/secret/token/password` assignments with a quoted value of 8 or more characters; it is a safety net, not a scanner. `gitleaks` runs in the audit.
- Stop checks that need a real test suite (red and green) can only run once `package.json` and the tests exist (DC-9).

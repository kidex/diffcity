#!/usr/bin/env bash
# PostToolUse(Write|Edit|MultiEdit): eslint --fix on the touched file and a
# project typecheck. Errors are fed back to Claude; the commit guard in
# guard-bash.sh refuses to commit while they remain.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

file="$(jq -r '.tool_input.file_path // ""')"
case "$file" in
  *.ts|*.tsx|*.mts|*.cts|*.js|*.mjs|*.cjs) ;;
  *) exit 0 ;;
esac
[ -f "$file" ] || exit 0

# Nearest package root, so worktrees under .worktrees/ are checked against their own config.
root="$(dirname "$file")"
while [ "$root" != "/" ] && [ ! -f "$root/package.json" ]; do root="$(dirname "$root")"; done
[ -x "$root/node_modules/.bin/eslint" ] || exit 0

errors=""
if ! out="$(cd "$root" && ./node_modules/.bin/eslint --fix "$file" 2>&1)"; then
  errors+="eslint:"$'\n'"$(tail -n 20 <<<"$out")"$'\n'
fi
if [ -x "$root/node_modules/.bin/tsc" ] && ! out="$(cd "$root" && ./node_modules/.bin/tsc --noEmit -p . 2>&1)"; then
  errors+="tsc:"$'\n'"$(grep -F "$(basename "$file")" <<<"$out" | head -n 20)"$'\n'"$(tail -n 1 <<<"$out")"
fi

if [ -n "$errors" ]; then
  echo "$errors" >&2
  exit 2
fi
exit 0

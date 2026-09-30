#!/usr/bin/env bash
# Stop: runs the test suite. Green tests let the session stop with a short
# summary; red tests send Claude back once to fix them or explain the failure.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

input="$(cat)"
# Second stop in a row: Claude has already seen the failure and explained it.
[ "$(jq -r '.stop_hook_active // false' <<<"$input")" = "true" ] && exit 0
[ -f "$PROJECT_DIR/package.json" ] && [ -d "$PROJECT_DIR/node_modules" ] || exit 0

out="$(cd "$PROJECT_DIR" && npm test --silent 2>&1)"
status=$?
summary="$(grep -E '^[[:space:]]*(Test Files|Tests|Duration|FAIL|×)' <<<"$out" | head -n 5)"
[ -z "$summary" ] && summary="$(tail -n 5 <<<"$out")"

if [ $status -eq 0 ]; then
  jq -n --arg s "$summary" '{systemMessage: ("npm test: green\n" + $s)}'
  exit 0
fi

{
  echo "npm test is red. Fix the failing tests, or explain the failure to the PO, before stopping."
  echo "$summary"
} >&2
exit 2

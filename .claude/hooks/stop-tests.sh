#!/usr/bin/env bash
# Stop: runs the tests touched since the last green run. Green tests let the
# session stop with a short summary; red tests send Claude back once to fix them
# or explain the failure.
#
# The full suite takes about ten minutes and competes with the agents' own runs,
# so this runs only what changed in the main checkout:
#   - uncommitted changes: `vitest related` on the changed source and test files;
#   - new commits since the last green run: `vitest --changed <that commit>`;
#   - nothing changed since the last green run: no tests.
# The full suite still runs before every merge and push.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

input="$(cat)"
# Second stop in a row: Claude has already seen the failure and explained it.
[ "$(jq -r '.stop_hook_active // false' <<<"$input")" = "true" ] && exit 0
[ -f "$PROJECT_DIR/package.json" ] && [ -d "$PROJECT_DIR/node_modules" ] || exit 0

cd "$PROJECT_DIR" || exit 0
marker=".tmp/stop-tests-green"
head="$(git rev-parse HEAD 2>/dev/null)" || exit 0
last="$(cat "$marker" 2>/dev/null || true)"
dirty="$(git status --porcelain --untracked-files=all -- src test | awk '{print $NF}' | grep -E '\.(ts|mts|mjs|js)$' || true)"

vitest=(node node_modules/vitest/vitest.mjs run --project main --passWithNoTests)
if [ -n "$dirty" ]; then
  # shellcheck disable=SC2086
  out="$("${vitest[@]}" --maxWorkers=2 related $dirty 2>&1)"
elif [ -n "$last" ] && [ "$last" = "$head" ]; then
  exit 0
elif [ -n "$last" ] && git cat-file -e "$last^{commit}" 2>/dev/null; then
  out="$("${vitest[@]}" --maxWorkers=2 --changed "$last" 2>&1)"
else
  out="$(npm test --silent 2>&1)"
fi
status=$?
summary="$(grep -E '^[[:space:]]*(Test Files|Tests|Duration|FAIL|×)' <<<"$out" | head -n 5)"
[ -z "$summary" ] && summary="$(tail -n 5 <<<"$out")"

if [ $status -eq 0 ]; then
  [ -z "$dirty" ] && mkdir -p .tmp && printf '%s\n' "$head" >"$marker"
  jq -n --arg s "$summary" '{systemMessage: ("tests for the changes: green\n" + $s)}'
  exit 0
fi

{
  echo "Tests for the changes are red. Fix the failing tests, or explain the failure to the PO, before stopping."
  echo "$summary"
} >&2
exit 2

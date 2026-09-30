#!/usr/bin/env bash
# PreToolUse(Bash): blocks destructive commands, writes outside the repo,
# access to the real diffcity config dir, and commits with lint or type errors.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

cmd="$(jq -r '.tool_input.command // ""')"
[ -z "$cmd" ] && exit 0

# Destructive commands from the deny list.
if grep -Eq 'git[[:space:]]+push[^|;&]*(--force|--force-with-lease|[[:space:]]-f([[:space:]]|$))' <<<"$cmd"; then
  block "force push is not allowed."
fi
if grep -Eq '(^|[;&|[:space:]])rm[[:space:]]+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r[[:space:]]+-f|-f[[:space:]]+-r|--recursive[[:space:]]+--force|--force[[:space:]]+--recursive)' <<<"$cmd"; then
  block "rm -rf is not allowed. Remove specific files, or ask the team lead."
fi

# The real config dir belongs to the user's installed diffcity; tests use a temp dir.
if grep -Eq '(~|\$HOME|\$\{HOME\}|'"$HOME"')/\.config/diffcity' <<<"$cmd"; then
  block "commands must not touch the real ~/.config/diffcity. Use a temporary directory."
fi

# Writes outside the repo: redirections and tee targets (heuristic).
while read -r target; do
  [ -z "$target" ] && continue
  target="${target%\"}"; target="${target#\"}"; target="${target%\'}"; target="${target#\'}"
  case "$target" in
    /*|~*) is_allowed_write_path "$target" || block "write outside the repo: $target" ;;
  esac
done < <(grep -Eo '(>>?|tee([[:space:]]+-a)?)[[:space:]]*[^[:space:];&|]+' <<<"$cmd" | sed -E 's/^(>>?|tee([[:space:]]+-a)?)[[:space:]]*//' | grep -v '^&')

# Commits must pass lint and typecheck.
if grep -Eq '(^|[;&|[:space:]])git[[:space:]]+commit' <<<"$cmd"; then
  root="$(git -C "$PROJECT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$PROJECT_DIR")"
  if [ -f "$root/package.json" ] && [ -d "$root/node_modules" ]; then
    if ! out="$(cd "$root" && npm run --silent lint 2>&1)"; then
      block "lint fails, fix before committing:"$'\n'"$(tail -n 30 <<<"$out")"
    fi
    if ! out="$(cd "$root" && npm run --silent typecheck 2>&1)"; then
      block "typecheck fails, fix before committing:"$'\n'"$(tail -n 30 <<<"$out")"
    fi
  fi
fi

exit 0

#!/usr/bin/env bash
# PreToolUse(Write|Edit|MultiEdit): blocks writes outside the repo and content
# that looks like a secret or a real home path. The repo is public.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

input="$(cat)"
file="$(jq -r '.tool_input.file_path // ""' <<<"$input")"
content="$(jq -r '[.tool_input.content, .tool_input.new_string, (.tool_input.edits // [] | .[].new_string)] | map(select(. != null)) | join("\n")' <<<"$input")"

if [ -n "$file" ] && ! is_allowed_write_path "$file"; then
  block "write outside the repo: $file"
fi

# Real home paths: the current home directory and user name.
user="$(id -un)"
if grep -Fq "$HOME" <<<"$content" || grep -Eq "/(Users|home)/$user(/|\b)" <<<"$content"; then
  block "content contains a real home path. Use a placeholder such as ~/projects/example or a temp dir."
fi

# Secret-looking values.
secret_patterns=(
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'AKIA[0-9A-Z]{16}'
  'gh[pousr]_[A-Za-z0-9]{36,}'
  'github_pat_[A-Za-z0-9_]{40,}'
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'sk-[A-Za-z0-9]{32,}'
  'xox[abprs]-[A-Za-z0-9-]{10,}'
  'ATATT[A-Za-z0-9_=-]{20,}'
  '(api[_-]?key|secret|token|passw(or)?d|auth)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"'[:space:]]{8,}["'"'"']'
)
for p in "${secret_patterns[@]}"; do
  if grep -Eiq -- "$p" <<<"$content"; then
    block "content looks like a secret (pattern: $p). Use an environment variable or an obviously fake value like 'test-token'."
  fi
done

exit 0

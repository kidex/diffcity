#!/usr/bin/env bash
# Shared helpers for the guardrail hooks. Sourced, not executed.

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"

# Print a message for Claude and block the tool call.
block() {
  echo "BLOCKED by $(basename "$0"): $*" >&2
  exit 2
}

# Resolve a path to an absolute, normalized form (works for paths that do not exist yet).
abspath() {
  node -e 'const p=require("path");const a=process.argv[1].replace(/^~(?=$|\/)/, require("os").homedir());console.log(p.resolve(a))' "$1"
}

# True when the path is inside the project or in a location Claude may legitimately write to.
is_allowed_write_path() {
  local target
  target="$(abspath "$1")"
  local tmp="${TMPDIR:-/tmp}"
  tmp="${tmp%/}"
  case "$target" in
    "$PROJECT_DIR"|"$PROJECT_DIR"/*) return 0 ;;
    /tmp/*|/private/tmp/*|/var/folders/*|"$tmp"/*) return 0 ;;
    /dev/null|/dev/stdout|/dev/stderr) return 0 ;;
    "$HOME"/.claude/projects/*/memory/*) return 0 ;;
  esac
  return 1
}

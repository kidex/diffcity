# diffcity shell hook for bash: runs `diffcity track` in the background when
# the shell enters a git repo. Add to ~/.bashrc:
#   eval "$(diffcity shell-init bash)"
# Set DIFFCITY_DISABLE_HOOK=1 to turn it off.
__diffcity_root=
__diffcity_pwd=
__diffcity_track() {
  case ${DIFFCITY_DISABLE_HOOK:-} in '' | 0) ;; *) return 0 ;; esac
  [ "$PWD" = "$__diffcity_pwd" ] && return 0
  __diffcity_pwd=$PWD
  local dir=$PWD root=
  while [ -n "$dir" ]; do
    if [ -e "$dir/.git" ]; then
      root=$dir
      break
    fi
    dir=${dir%/*}
  done
  [ "$root" = "$__diffcity_root" ] && return 0
  __diffcity_root=$root
  [ -z "$root" ] && return 0
  ( '/placeholder/bin/node' '/placeholder/lib/diffcity/dist/cli/index.js' track "$root" </dev/null >/dev/null 2>&1 & )
}
__diffcity_prompt() {
  local __diffcity_status=$?
  __diffcity_track
  return $__diffcity_status
}
if [ "${BASH_VERSINFO[0]}" -gt 5 ] || { [ "${BASH_VERSINFO[0]}" -eq 5 ] && [ "${BASH_VERSINFO[1]}" -ge 1 ]; }; then
  case " ${PROMPT_COMMAND[*]-} " in
    *' __diffcity_prompt '*) ;;
    *) PROMPT_COMMAND+=(__diffcity_prompt) ;;
  esac
else
  case ";${PROMPT_COMMAND:-};" in
    *';__diffcity_prompt;'*) ;;
    *) PROMPT_COMMAND="__diffcity_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
  esac
fi
__diffcity_track

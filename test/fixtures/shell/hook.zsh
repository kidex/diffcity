# diffcity shell hook for zsh: runs `diffcity track` in the background when
# the shell enters a git repo. Add to ~/.zshrc:
#   eval "$(diffcity shell-init zsh)"
# Set DIFFCITY_DISABLE_HOOK=1 to turn it off.
typeset -g __diffcity_root=
__diffcity_chpwd() {
  emulate -L zsh
  [[ -n ${DIFFCITY_DISABLE_HOOK:-} && ${DIFFCITY_DISABLE_HOOK} != 0 ]] && return 0
  local dir=$PWD root=
  while [[ -n $dir ]]; do
    if [[ -e $dir/.git ]]; then
      root=$dir
      break
    fi
    dir=${dir%/*}
  done
  [[ $root == "$__diffcity_root" ]] && return 0
  __diffcity_root=$root
  [[ -z $root ]] && return 0
  '/placeholder/bin/node' '/placeholder/lib/diffcity/dist/cli/index.js' track "$root" </dev/null >/dev/null 2>&1 &!
}
autoload -Uz add-zsh-hook
add-zsh-hook chpwd __diffcity_chpwd
__diffcity_chpwd

# diffcity shell hook for fish: runs `diffcity track` in the background when
# the shell enters a git repo. Add to ~/.config/fish/config.fish:
#   diffcity shell-init fish | source
# Set DIFFCITY_DISABLE_HOOK=1 to turn it off.
set -g __diffcity_root ''
function __diffcity_pwd --on-variable PWD
    if test -n "$DIFFCITY_DISABLE_HOOK"; and test "$DIFFCITY_DISABLE_HOOK" != 0
        return 0
    end
    set -l dir $PWD
    set -l root ''
    while test -n "$dir"
        if test -e "$dir/.git"
            set root $dir
            break
        end
        set dir (string replace -r '/[^/]*$' '' -- $dir)
    end
    test "$root" = "$__diffcity_root"; and return 0
    set -g __diffcity_root $root
    test -z "$root"; and return 0
    '/placeholder/bin/node' '/placeholder/lib/diffcity/dist/cli/index.js' track $root </dev/null >/dev/null 2>&1 &
    disown $last_pid 2>/dev/null
end
__diffcity_pwd

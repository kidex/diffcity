// `diffcity shell-init [zsh|bash|fish]` (SPEC.md section 3, 3a C1, ADR-016).
// Prints the shell hook that runs `diffcity track` when the shell enters a
// repo. The hook's synchronous part must stay well under 50 ms, so it:
// - finds the repo root by walking up from $PWD with builtins only (no process);
// - calls track only when that root changes (entering a repo, at its root or in
//   a subfolder, moving to another repo, coming back after leaving it);
// - starts track in the background with its output discarded and no job notice;
// - calls node and the CLI script by absolute paths, quoted for the shell, so a
//   Node version switch or a CLI missing from PATH does not break it;
// - does nothing when DIFFCITY_DISABLE_HOOK is set (to anything but 0);
// - runs once when the script is evaluated, for the shell's initial directory.
// The bash script also runs on bash 3.2, the macOS default.

import { fileURLToPath } from 'node:url';

export const SHELLS = ['zsh', 'bash', 'fish'] as const;
export type Shell = (typeof SHELLS)[number];

/** Absolute paths the hook runs: `<node> <cli> track <root>`. */
export interface HookCommand {
  node: string;
  cli: string;
}

/** Quotes a word for zsh and bash: single quotes, with `'` written as `'\''`. */
export function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Quotes a word for fish: single quotes, where only `\` and `'` are escaped. */
export function quoteFish(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

const header = (shell: Shell, rcFile: string, install: string): string =>
  `# diffcity shell hook for ${shell}: runs \`diffcity track\` in the background when
# the shell enters a git repo. Add to ${rcFile}:
#   ${install}
# Set DIFFCITY_DISABLE_HOOK=1 to turn it off.
`;

function zshScript({ node, cli }: HookCommand): string {
  return `${header('zsh', '~/.zshrc', 'eval "$(diffcity shell-init zsh)"')}typeset -g __diffcity_root=
__diffcity_chpwd() {
  emulate -L zsh
  [[ -n \${DIFFCITY_DISABLE_HOOK:-} && \${DIFFCITY_DISABLE_HOOK} != 0 ]] && return 0
  local dir=$PWD root=
  while [[ -n $dir ]]; do
    if [[ -e $dir/.git ]]; then
      root=$dir
      break
    fi
    dir=\${dir%/*}
  done
  [[ $root == "$__diffcity_root" ]] && return 0
  __diffcity_root=$root
  [[ -z $root ]] && return 0
  ${quotePosix(node)} ${quotePosix(cli)} track "$root" </dev/null >/dev/null 2>&1 &!
}
autoload -Uz add-zsh-hook
add-zsh-hook chpwd __diffcity_chpwd
__diffcity_chpwd
`;
}

function bashScript({ node, cli }: HookCommand): string {
  // PROMPT_COMMAND runs before every prompt, so the walk is skipped unless $PWD
  // changed. __diffcity_prompt keeps $? for the prompt and later commands.
  return `${header('bash', '~/.bashrc', 'eval "$(diffcity shell-init bash)"')}__diffcity_root=
__diffcity_pwd=
__diffcity_track() {
  case \${DIFFCITY_DISABLE_HOOK:-} in '' | 0) ;; *) return 0 ;; esac
  [ "$PWD" = "$__diffcity_pwd" ] && return 0
  __diffcity_pwd=$PWD
  local dir=$PWD root=
  while [ -n "$dir" ]; do
    if [ -e "$dir/.git" ]; then
      root=$dir
      break
    fi
    dir=\${dir%/*}
  done
  [ "$root" = "$__diffcity_root" ] && return 0
  __diffcity_root=$root
  [ -z "$root" ] && return 0
  ( ${quotePosix(node)} ${quotePosix(cli)} track "$root" </dev/null >/dev/null 2>&1 & )
}
__diffcity_prompt() {
  local __diffcity_status=$?
  __diffcity_track
  return $__diffcity_status
}
if [ "\${BASH_VERSINFO[0]}" -gt 5 ] || { [ "\${BASH_VERSINFO[0]}" -eq 5 ] && [ "\${BASH_VERSINFO[1]}" -ge 1 ]; }; then
  case " \${PROMPT_COMMAND[*]-} " in
    *' __diffcity_prompt '*) ;;
    *) PROMPT_COMMAND+=(__diffcity_prompt) ;;
  esac
else
  case ";\${PROMPT_COMMAND:-};" in
    *';__diffcity_prompt;'*) ;;
    *) PROMPT_COMMAND="__diffcity_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
  esac
fi
__diffcity_track
`;
}

function fishScript({ node, cli }: HookCommand): string {
  return `${header('fish', '~/.config/fish/config.fish', 'diffcity shell-init fish | source')}set -g __diffcity_root ''
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
    ${quoteFish(node)} ${quoteFish(cli)} track $root </dev/null >/dev/null 2>&1 &
    disown $last_pid 2>/dev/null
end
__diffcity_pwd
`;
}

export function shellInitScript(shell: Shell, command: HookCommand): string {
  switch (shell) {
    case 'zsh':
      return zshScript(command);
    case 'bash':
      return bashScript(command);
    case 'fish':
      return fishScript(command);
  }
}

const isShell = (value: string): value is Shell => (SHELLS as readonly string[]).includes(value);

/** The running node and the CLI entry next to this module (dist/cli/index.js once built). */
export function defaultHookCommand(): HookCommand {
  return { node: process.execPath, cli: fileURLToPath(new URL('./index.js', import.meta.url)) };
}

export interface ShellInitDeps {
  io: { stdout: (text: string) => void; stderr: (text: string) => void };
  /** Defaults to defaultHookCommand(). */
  command?: HookCommand;
}

/** Prints the script; resolves with the exit code (1 for an unknown shell). */
export function runShellInit(shell: string | undefined, deps: ShellInitDeps): number {
  const name = shell ?? 'zsh';
  if (!isShell(name)) {
    deps.io.stderr(`diffcity shell-init: unsupported shell: ${name} (supported: ${SHELLS.join(', ')})\n`);
    return 1;
  }
  deps.io.stdout(shellInitScript(name, deps.command ?? defaultHookCommand()));
  return 0;
}

// Command modules are loaded with import() inside their action, so a command
// loads only what it needs: `track` runs from the shell hook on every repo
// entry and must not pay for the parser that `diff` loads (ADR-016).

import { Command } from 'commander';
import type { DiffCommandOptions } from './diff.js';
import type { ImportCommandOptions } from './import.js';
import type { StartCommandOptions } from './start.js';
import type { TrackCommandOptions } from './track.js';
import type { TrustCommandOptions } from './trust.js';
import type { UpCommandOptions } from './up.js';
import { readVersion } from './version.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Working directory the commands act on; defaults to process.cwd(). */
  cwd?: () => string;
  /** Environment the commands read; defaults to process.env. */
  env?: () => NodeJS.ProcessEnv;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

function notImplemented(io: CliIo, name: string): () => void {
  return () => {
    io.stderr(`diffcity ${name}: not implemented yet\n`);
    process.exitCode = 2;
  };
}

export function buildProgram(io: CliIo = defaultIo): Command {
  const program = new Command();

  program
    .name('diffcity')
    .description('Local visual code review for code written by AI agents.')
    .version(readVersion(), '-V, --version', 'print the diffcity version')
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  // start and stop come first: they are the commands most people need.
  program
    .command('start')
    .description('open the current repo (or <dir>) in the browser, starting the daemon if needed')
    .argument('[dir]', 'repo directory (default: the repo containing the current directory)')
    .option('--port <port>', 'port for the UI and API (default: the last one used, else 4321; 0 picks a free port)')
    .option('--no-open', 'do not open the browser')
    .action(async (dir: string | undefined, options: StartCommandOptions) => {
      const { runStart } = await import('./start.js');
      process.exitCode = await runStart(dir, options, { io, env: io.env?.() ?? process.env, cwd: io.cwd?.() ?? process.cwd() });
    });

  program
    .command('stop')
    .description('stop the daemon')
    .action(async () => {
      const { runStop } = await import('./stop.js');
      process.exitCode = await runStop({ io, env: io.env?.() ?? process.env });
    });

  program
    .command('up')
    .description('start the daemon and open the UI on localhost')
    .option('--port <port>', 'port for the UI and API (default: the last one used, else 4321; 0 picks a free port)')
    .option('--no-open', 'do not open the browser')
    .option('--foreground', 'run the daemon in this process, logging to stderr')
    .action(async (options: UpCommandOptions) => {
      const { runUp } = await import('./up.js');
      const code = await runUp(options, { io, env: io.env?.() ?? process.env });
      process.exitCode = code;
      // A foreground daemon has stopped: exit even if a forced shutdown left a plugin's handles open.
      if (options.foreground === true) {
        process.stdout.write('', () => {
          process.stderr.write('', () => process.exit(code));
        });
      }
    });

  program
    .command('trust')
    .description("let the daemon load a repo's diffcity.config.js (it runs code); --list, --remove")
    .argument('[dir]', 'repo directory (default: the current directory)')
    .option('--list', 'print the trusted repos')
    .option('--remove', 'stop trusting the repo')
    .action(async (dir: string | undefined, options: TrustCommandOptions) => {
      const { runTrust } = await import('./trust.js');
      process.exitCode = await runTrust(dir, options, { io, env: io.env?.() ?? process.env, cwd: io.cwd?.() ?? process.cwd() });
    });

  program
    .command('shell-init')
    .description('print the shell hook that tracks repos on cd')
    .argument('[shell]', 'zsh, bash or fish', 'zsh')
    .action(async (shell: string) => {
      const { runShellInit } = await import('./shell-init.js');
      process.exitCode = runShellInit(shell, { io });
    });

  program
    .command('track')
    .description('register a repo and ask the daemon to collect its changes')
    .argument('[dir]', 'repo directory (default: the current directory, or cwd from the hook input with --agent)')
    .option('--agent', 'mark the current change as "agent worked, not reviewed"; reads the Claude Code hook JSON from stdin')
    .action(async (dir: string | undefined, options: TrackCommandOptions) => {
      const { runTrack } = await import('./track.js');
      process.exitCode = await runTrack(dir, options, { io, env: io.env?.() ?? process.env, cwd: io.cwd?.() ?? process.cwd() });
    });

  program
    .command('scan')
    .description('discover and register every repo under a folder')
    .argument('<dir>', 'folder to scan')
    .action(async (dir: string) => {
      const { runScan } = await import('./scan.js');
      process.exitCode = await runScan(dir, { io, env: io.env?.() ?? process.env, cwd: io.cwd?.() ?? process.cwd() });
    });

  program
    .command('diff')
    .description('semantic diff of the current change')
    .option('--json', 'print the report as JSON')
    .option('--compact', 'with --json: leave out untouched files and the packages left without files')
    .option('--base <ref>', 'base ref')
    .option('--head <ref>', 'head ref')
    .action(async (options: DiffCommandOptions) => {
      const { NOW_ENV, runDiff } = await import('./diff.js');
      const cwd = io.cwd?.() ?? process.cwd();
      const env = io.env?.() ?? process.env;
      process.exitCode = await runDiff(options, { cwd, io, now: env[NOW_ENV] });
    });

  program
    .command('import')
    .description('anchor findings (own JSON or SARIF) to symbols of the current change')
    .argument('<file>', 'findings.json or *.sarif.json')
    .option('--open', 'open the change in the UI after importing')
    .action(async (file: string, options: ImportCommandOptions) => {
      const { runImport } = await import('./import.js');
      process.exitCode = await runImport(file, options, { io, env: io.env?.() ?? process.env, cwd: io.cwd?.() ?? process.cwd() });
    });

  program
    .command('export')
    .description('self-contained export of the current change')
    .argument('<format>', 'html or puml')
    .option('--out <path>', 'output file')
    .action(notImplemented(io, 'export'));

  program
    .command('status')
    .description('repos ordered by urgency: unreviewed changes, stale audits')
    .action(notImplemented(io, 'status'));

  program
    .command('audit')
    .description('full audit: dependencies, semgrep, gitleaks, AI review on tier 1')
    .argument('[repo]', 'repo to audit')
    .option('--stale', 'audit every stale repo')
    .action(notImplemented(io, 'audit'));

  return program;
}

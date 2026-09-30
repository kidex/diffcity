import { Command } from 'commander';
import { runDiff, type DiffCommandOptions } from './diff.js';
import { readVersion } from './version.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Working directory the commands act on; defaults to process.cwd(). */
  cwd?: () => string;
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

  program
    .command('up')
    .description('start the daemon and open the UI on localhost')
    .option('--port <port>', 'port for the UI and API', '4321')
    .action(notImplemented(io, 'up'));

  program
    .command('shell-init')
    .description('print the shell hook that tracks repos on cd')
    .argument('[shell]', 'zsh, bash or fish', 'zsh')
    .action(notImplemented(io, 'shell-init'));

  program
    .command('track')
    .description('register a repo and ask the daemon to collect its changes')
    .argument('[dir]', 'repo directory', '.')
    .option('--agent', 'mark the current change as "agent worked, not reviewed"')
    .action(notImplemented(io, 'track'));

  program
    .command('scan')
    .description('discover and register every repo under a folder')
    .argument('<dir>', 'folder to scan')
    .action(notImplemented(io, 'scan'));

  program
    .command('diff')
    .description('semantic diff of the current change')
    .option('--json', 'print the report as JSON')
    .option('--base <ref>', 'base ref')
    .option('--head <ref>', 'head ref')
    .action(async (options: DiffCommandOptions) => {
      const cwd = io.cwd?.() ?? process.cwd();
      process.exitCode = await runDiff(options, { cwd, io });
    });

  program
    .command('import')
    .description('anchor findings (own JSON or SARIF) to symbols of the current change')
    .argument('<file>', 'findings.json or *.sarif.json')
    .option('--open', 'open the change in the UI after importing')
    .action(notImplemented(io, 'import'));

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

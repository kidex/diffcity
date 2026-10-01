// `diffcity track [<dir>] [--agent]` (SPEC.md section 3, ADR-016).
// The shell hook runs this on every repo entry, so the module stays light: it
// may load the socket client and src/core/home, never the parser
// (web-tree-sitter) or src/core/report. test/integration/cli/track-lazy-imports
// guards that.

export interface TrackCommandOptions {
  agent?: boolean;
}

export interface TrackDeps {
  io: { stderr: (text: string) => void };
}

/** Runs the command; resolves with the process exit code. Not implemented yet. */
export function runTrack(_dir: string, _options: TrackCommandOptions, deps: TrackDeps): Promise<number> {
  deps.io.stderr('diffcity track: not implemented yet\n');
  return Promise.resolve(2);
}

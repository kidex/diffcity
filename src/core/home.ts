// The diffcity home directory and the files the daemon keeps in it (ADR-015).
// SPEC.md sections 4.2 and 10 place everything in ~/.config/diffcity; DIFFCITY_HOME
// overrides it, which is how tests stay out of the real directory.

import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, normalize, sep } from 'node:path';

/** Environment variable that overrides the home directory; must be an absolute path. */
export const HOME_ENV = 'DIFFCITY_HOME';

/**
 * Longest Unix socket path, in bytes, kept inside the home. macOS allows 104
 * bytes for `sun_path`; past this limit the socket moves to os.tmpdir().
 */
export const MAX_SOCKET_PATH_BYTES = 100;

/** Absolute paths of everything the daemon writes, all inside the home except a relocated socket. */
export interface HomePaths {
  /** The home directory itself. */
  home: string;
  /** `diffcity.db`: SQLite (ADR-018). */
  db: string;
  /** `daemon.lock`: pid of the daemon that owns the instance. */
  lock: string;
  /** `daemon.json`: the DaemonInfo record, written once the daemon is ready. */
  daemonJson: string;
  /** The local socket (ADR-016): `daemon.sock`, or a file in os.tmpdir() for long homes. */
  socket: string;
  /** `daemon.log`: rotated at 5 MB with one previous file kept. */
  log: string;
  /** `state.json`: the DaemonState record, the last port chosen with `up --port`. */
  state: string;
  /** `settings.json`: the user settings, the trusted repos among them (ADR-030). */
  settings: string;
}

/**
 * The diffcity home: DIFFCITY_HOME when set, otherwise `~/.config/diffcity`.
 * Throws when DIFFCITY_HOME is set to anything but an absolute path (an empty
 * value included), so a typo never silently falls back to the real directory.
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[HOME_ENV];
  if (override === undefined) return join(homedir(), '.config', 'diffcity');
  if (!isAbsolute(override)) {
    throw new Error(`${HOME_ENV} must be an absolute path, got ${JSON.stringify(override)}`);
  }
  const normalized = normalize(override);
  return normalized.length > 1 && normalized.endsWith(sep) ? normalized.slice(0, -1) : normalized;
}

/**
 * The socket path for a home: `<home>/daemon.sock`, or
 * `<os.tmpdir()>/diffcity-<first 12 hex of sha256(home)>.sock` when that is
 * longer than MAX_SOCKET_PATH_BYTES. The daemon records the path it actually
 * uses in daemon.json.
 */
export function socketPathFor(home: string): string {
  const inHome = join(home, 'daemon.sock');
  if (Buffer.byteLength(inHome, 'utf8') <= MAX_SOCKET_PATH_BYTES) return inHome;
  const digest = createHash('sha256').update(home).digest('hex').slice(0, 12);
  return join(tmpdir(), `diffcity-${digest}.sock`);
}

/** Every file path under a home returned by resolveHome. Pure: touches nothing on disk. */
export function homePaths(home: string): HomePaths {
  return {
    home,
    db: join(home, 'diffcity.db'),
    lock: join(home, 'daemon.lock'),
    daemonJson: join(home, 'daemon.json'),
    socket: socketPathFor(home),
    log: join(home, 'daemon.log'),
    state: join(home, 'state.json'),
    settings: join(home, 'settings.json'),
  };
}

/** Creates the home (and missing parents) with mode 0700; a no-op when it exists. */
export async function ensureHome(home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
}

// The CLI and the daemon report the same version; it lives in src/core so the
// daemon can read it without importing from src/cli.
export { readVersion } from '../core/version.js';

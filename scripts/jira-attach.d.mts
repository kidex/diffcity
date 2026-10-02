// Types of scripts/jira-attach.mjs, for its unit test.

/** Everything with side effects that main() uses; each defaults to the real one. */
export interface JiraAttachIo {
  env?: Record<string, string | undefined>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Runs `security` with the arguments; stdout, or null when it fails. */
  security?: (args: string[]) => Promise<string | null>;
  readFile?: (path: string) => Promise<Uint8Array>;
  isFile?: (path: string) => Promise<boolean>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface Credentials {
  email: string;
  token: string;
  baseUrl: string;
}

export const KEYCHAIN_SERVICE: string;
export const SETUP_HINT: string;
export function runSecurity(args: string[]): Promise<string | null>;
export function parseArgs(args: string[]): { key: string; files: string[] } | { error: string };
export function keychainAttribute(listing: string, name: string): string | null;
export function resolveCredentials(
  env: Record<string, string | undefined>,
  security: (args: string[]) => Promise<string | null>,
): Promise<Credentials | { error: string; code: number }>;
export function redact(text: string, ...secrets: (string | undefined)[]): string;
export function main(argv: string[], io?: JiraAttachIo): Promise<number>;

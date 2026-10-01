// The daemon log (ADR-015): `daemon.log` in the home, rotated at 5 MB with one
// previous file (`daemon.log.1`) kept. In the foreground the log goes to stderr.

import { closeSync, fstatSync, openSync, renameSync, writeSync } from 'node:fs';

/** Size at which daemon.log is moved to daemon.log.1. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Flushes and releases the file; later calls write nothing. */
  close(): void;
}

function formatLine(level: LogLevel, message: string, now: Date): string {
  return `${now.toISOString()} ${level} ${message}\n`;
}

export interface FileLoggerOptions {
  /** Rotation threshold in bytes; defaults to LOG_MAX_BYTES. */
  maxBytes?: number;
  now?: () => Date;
}

/**
 * Appends lines to `path`. Before a line that would take the file past
 * `maxBytes`, the file is renamed to `<path>.1` (replacing any older one) and a
 * new file is started. Writes are synchronous so nothing is lost on exit.
 */
export function createFileLogger(path: string, options: FileLoggerOptions = {}): Logger {
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  const now = options.now ?? (() => new Date());
  let fd: number | null = openSync(path, 'a', 0o600);
  let size = fstatSync(fd).size;

  const write = (level: LogLevel, message: string): void => {
    if (fd === null) return;
    const line = Buffer.from(formatLine(level, message, now()), 'utf8');
    if (size > 0 && size + line.length > maxBytes) {
      closeSync(fd);
      renameSync(path, `${path}.1`);
      fd = openSync(path, 'a', 0o600);
      size = 0;
    }
    writeSync(fd, line);
    size += line.length;
  };

  return {
    info: (message) => {
      write('info', message);
    },
    warn: (message) => {
      write('warn', message);
    },
    error: (message) => {
      write('error', message);
    },
    close: () => {
      if (fd !== null) closeSync(fd);
      fd = null;
    },
  };
}

/** A logger on a stream (stderr for `up --foreground`); close() leaves the stream open. */
export function createStreamLogger(stream: NodeJS.WritableStream, now: () => Date = () => new Date()): Logger {
  let open = true;
  const write = (level: LogLevel, message: string): void => {
    if (open) stream.write(formatLine(level, message, now()));
  };
  return {
    info: (message) => {
      write('info', message);
    },
    warn: (message) => {
      write('warn', message);
    },
    error: (message) => {
      write('error', message);
    },
    close: () => {
      open = false;
    },
  };
}

/** Message of an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

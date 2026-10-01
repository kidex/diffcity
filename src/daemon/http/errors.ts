// API errors are JSON: `{ error: { code, message } }` (ADR-017). A route throws
// HttpError for an expected failure (404 `no-snapshot`, ...); anything else is
// a 500 whose details stay in the log.

import type { FastifyReply } from 'fastify';
import type { ApiError } from '../../core/model/types.js';

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const CODES: Readonly<Record<number, string>> = {
  400: 'bad-request',
  403: 'forbidden',
  404: 'not-found',
  405: 'method-not-allowed',
  413: 'payload-too-large',
  415: 'unsupported-media-type',
  421: 'misdirected-request',
};

/** The error code for a status without an explicit one. */
export function codeForStatus(statusCode: number): string {
  return CODES[statusCode] ?? (statusCode >= 500 ? 'internal' : 'error');
}

export function apiError(code: string, message: string): ApiError {
  return { error: { code, message } };
}

/** Sends a JSON error response. */
export function sendError(reply: FastifyReply, statusCode: number, code: string, message: string): FastifyReply {
  return reply.status(statusCode).type('application/json; charset=utf-8').send(apiError(code, message));
}

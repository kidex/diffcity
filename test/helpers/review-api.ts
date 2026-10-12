// A raw HTTP call to the daemon's JSON API with full control of the browser
// headers (Origin, Sec-Fetch-Site, Content-Type), for the review write guard.

import { request } from 'node:http';

export interface Answer {
  status: number;
  contentType: string;
  /** The response headers, lower-cased names. */
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json(): unknown;
}

export interface CallOptions {
  /** Sent as JSON text when it is not a string. */
  body?: unknown;
  /** Replaces the default headers (own Origin, JSON content type when there is a body). */
  headers?: Record<string, string>;
}

/** A request from the daemon's own page: the own Origin, and JSON when there is a body. */
export function call(port: number, method: string, path: string, options: CallOptions = {}): Promise<Answer> {
  const payload = options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  const headers: Record<string, string> = options.headers ?? {
    origin: `http://127.0.0.1:${String(port)}`,
    ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
  };
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          contentType: res.headers['content-type'] ?? '',
          headers: res.headers,
          text,
          json: (): unknown => JSON.parse(text),
        });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

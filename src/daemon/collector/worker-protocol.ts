// The message protocol between the collector pool and its worker threads
// (ADR-021): one request per job, one reply per request, matched by `id`.

export interface JobRequest<I> {
  id: number;
  input: I;
}

export type JobReply<O> = { id: number; ok: true; result: O } | { id: number; ok: false; error: string };

export function isJobRequest(value: unknown): value is JobRequest<unknown> {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'number' && 'input' in value;
}

export function isJobReply(value: unknown): value is JobReply<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (!('id' in value) || typeof value.id !== 'number' || !('ok' in value)) return false;
  return value.ok === true ? 'result' in value : value.ok === false && 'error' in value && typeof value.error === 'string';
}

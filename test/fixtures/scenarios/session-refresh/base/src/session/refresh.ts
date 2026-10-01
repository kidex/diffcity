import { readCookie } from './cookie';

export const SESSION_TTL_MS = 15 * 60 * 1000;

export interface Session {
  userId: string;
  issuedAt: number;
}

export function isExpired(session: Session, now: number): boolean {
  return now - session.issuedAt > SESSION_TTL_MS;
}

export function refreshSession(raw: string): Session | null {
  const session = readCookie(raw);
  if (session === null) return null;
  return { ...session, issuedAt: Date.now() };
}

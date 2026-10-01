import type { Session } from './refresh';

export function readCookie(raw: string): Session | null {
  const [userId, issuedAt] = raw.split('.');
  if (userId === undefined || issuedAt === undefined) return null;
  return { userId, issuedAt: Number(issuedAt) };
}

export function writeCookie(session: Session): string {
  return `${session.userId}.${String(session.issuedAt)}`;
}

export const SESSION_TTL_MS = 15 * 60 * 1000;

export interface Session {
  userId: string;
  issuedAt: number;
  rotation: number;
}

export function isExpired(session: Session, now: number): boolean {
  return now - session.issuedAt > SESSION_TTL_MS;
}

export function refreshSession(session: Session, now: number = Date.now()): Session | null {
  if (isExpired(session, now)) return null;
  return rotate(session, now);
}

export function rotate(session: Session, now: number): Session {
  return { ...session, issuedAt: now, rotation: session.rotation + 1 };
}

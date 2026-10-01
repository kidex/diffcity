import { Role } from './roles';

interface User {
  id: string;
  role: Role;
}

export class OrderGuard {
  canRead(user: User): boolean {
    return user.role === Role.Admin || user.role === Role.Member;
  }

  canPlace(user: User): boolean {
    if (user.role === Role.Admin) return true;
    return user.role === Role.Member;
  }
}

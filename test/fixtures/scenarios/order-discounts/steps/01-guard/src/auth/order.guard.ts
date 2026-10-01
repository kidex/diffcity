import { Role } from './roles';

interface User {
  id: string;
  role: Role;
}

interface Order {
  ownerId: string;
}

export class OrderGuard {
  canRead(user: User): boolean {
    return user.role === Role.Admin || user.role === Role.Member;
  }

  canPlace(user: User, order?: Order): boolean {
    if (user.role === Role.Admin) return true;
    return order ? order.ownerId === user.id : true;
  }
}

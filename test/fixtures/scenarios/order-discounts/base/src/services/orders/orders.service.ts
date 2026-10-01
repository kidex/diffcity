import type { CreateOrderDto } from '../../api/orders/orders.dto';
import type { OrdersRepo } from '../../repo/orders.repo';
import { Money } from '../../shared/money';
import { NotFound } from '../../shared/errors';

export class OrdersService {
  constructor(private readonly repo: OrdersRepo) {}

  async place(user: { id: string }, dto: CreateOrderDto) {
    this.validate(dto);
    const total = dto.items.reduce((sum, item) => sum.plus(Money.of(item.length)), Money.zero());
    return this.repo.insert({ ownerId: user.id, total });
  }

  validate(dto: CreateOrderDto): void {
    if (dto.items.length === 0) throw new NotFound('items');
  }
}

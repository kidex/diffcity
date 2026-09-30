import type { CreateOrderDto } from '../../api/orders/orders.dto';
import type { OrdersRepo } from '../../repo/orders.repo';
import { Money } from '../../shared/money';
import { NotFound } from '../../shared/errors';
import { log } from '../../shared/logger';
import type { DiscountRule } from './discount.rules';
import { send } from './mailer';

export class OrdersService {
  constructor(private readonly repo: OrdersRepo) {}

  async place(user: { id: string }, dto: CreateOrderDto) {
    this.validate(dto);
    const total = this.calcTotal(dto);
    const discounted = this.applyDiscount(total, dto.rules);
    const order = await this.repo.insert({ ownerId: user.id, total, discounted, discountPct: dto.discountPct });
    await this.notify(user.id);
    return order;
  }

  validate(dto: CreateOrderDto): void {
    if (dto.items.length === 0) throw new NotFound('items');
    if (dto.discountPct < 0) throw new NotFound('discount');
  }

  calcTotal(dto: CreateOrderDto): Money {
    return dto.items.reduce((sum, item) => sum.plus(Money.of(item.length)), Money.zero());
  }

  private applyDiscount(total: Money, rules: DiscountRule[]) {
    const pct = rules.reduce((p, r) => p + r.percentage(total), 0);
    return total.times(1 - pct / 100);
  }

  async notify(userId: string): Promise<void> {
    await send(userId, 'Your order was placed');
  }
}

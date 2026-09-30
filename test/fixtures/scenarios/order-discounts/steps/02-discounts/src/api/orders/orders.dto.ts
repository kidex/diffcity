import type { DiscountRule } from '../../services/orders/discount.rules';

export class CreateOrderDto {
  items: string[] = [];
  discountPct = 0;
  rules: DiscountRule[] = [];

  static from(body: unknown): CreateOrderDto {
    const dto = new CreateOrderDto();
    dto.items = (body as { items?: string[] }).items ?? [];
    return dto;
  }
}

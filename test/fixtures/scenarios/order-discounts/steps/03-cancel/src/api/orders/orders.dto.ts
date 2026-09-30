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

export class CancelOrderDto {
  id = '';
  reason = '';

  static from(params: Record<string, string>, body: unknown): CancelOrderDto {
    const dto = new CancelOrderDto();
    dto.id = params.id ?? '';
    dto.reason = (body as { reason?: string }).reason ?? '';
    return dto;
  }
}

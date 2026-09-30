export class CreateOrderDto {
  items: string[] = [];

  static from(body: unknown): CreateOrderDto {
    const dto = new CreateOrderDto();
    dto.items = (body as { items?: string[] }).items ?? [];
    return dto;
  }
}

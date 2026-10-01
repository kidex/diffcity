import { CancelOrderDto, CreateOrderDto } from './orders.dto';
import type { OrdersService } from '../../services/orders/orders.service';

interface Req {
  user: { id: string };
  params: Record<string, string>;
  body: unknown;
}

interface Res {
  status(code: number): Res;
  json(value: unknown): void;
}

export class OrdersController {
  constructor(private readonly svc: OrdersService) {}

  async list(req: Req, res: Res) {
    res.json(await this.svc.list(req.user));
  }

  async get(req: Req, res: Res) {
    res.json(await this.svc.get(req.user, req.params.id));
  }

  async create(req: Req, res: Res) {
    const dto = CreateOrderDto.from(req.body);
    const order = await this.svc.place(req.user, dto);
    res.status(201).json({ order, discounted: dto.discountPct > 0 });
  }

  async cancel(req: Req, res: Res) {
    const dto = CancelOrderDto.from(req.params, req.body);
    const order = await this.svc.cancel(req.user, dto);
    res.status(200).json(order);
  }
}

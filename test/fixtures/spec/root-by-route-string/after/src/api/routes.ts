import { listLoaves, sliceLoaf } from './loaves';

interface Router {
  get(path: string, handler: unknown): void;
  post(path: string, handler: unknown): void;
}

export function registerRoutes(app: Router): void {
  app.get('/loaves', listLoaves);
  app.post('/loaves/:id/slice', sliceLoaf);
}

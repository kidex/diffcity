import { serveSample } from './__tests__/samples';

export function registerRoutes(app: { get: (...args: unknown[]) => void }): void {
  app.get('/health', () => 'ok');
  app.get('/samples', serveSample);
}

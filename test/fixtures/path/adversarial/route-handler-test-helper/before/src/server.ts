export function registerRoutes(app: { get: (...args: unknown[]) => void }): void {
  app.get('/health', () => 'ok');
}

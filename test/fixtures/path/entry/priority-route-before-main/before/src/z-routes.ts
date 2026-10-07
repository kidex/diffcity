interface App {
  get(path: string, ...handlers: unknown[]): void;
  post(path: string, ...handlers: unknown[]): void;
}

export function registerRoutes(app: App): void {
  app.get('/status', () => 'ok');
}

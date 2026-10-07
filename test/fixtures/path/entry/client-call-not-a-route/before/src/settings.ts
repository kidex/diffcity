declare const app: { get(name: string): string };

export function mode(): string {
  return app.get('env');
}

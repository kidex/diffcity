export async function send(to: string, subject: string): Promise<void> {
  await Promise.resolve({ to, subject, body: template(subject) });
}

export function template(subject: string): string {
  return `<h1>${subject}</h1>`;
}

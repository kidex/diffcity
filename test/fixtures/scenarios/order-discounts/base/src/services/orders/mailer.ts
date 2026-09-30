export async function send(to: string, subject: string): Promise<void> {
  await Promise.resolve({ to, subject });
}

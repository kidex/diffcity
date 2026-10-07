declare const api: { get(path: string): Promise<string[]> };

export async function loadUsers(): Promise<string[]> {
  const users = await api.get('/users');
  return users.sort();
}

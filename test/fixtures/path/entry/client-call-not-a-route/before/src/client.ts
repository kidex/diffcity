declare const api: { get(path: string): Promise<string[]> };

export async function loadUsers(): Promise<string[]> {
  return await api.get('/users');
}

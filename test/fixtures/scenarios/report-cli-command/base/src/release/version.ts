export function nextVersion(current: string): string {
  const [major = 0, minor = 0] = current.split('.').map(Number);
  return `${String(major)}.${String(minor + 1)}.0`;
}

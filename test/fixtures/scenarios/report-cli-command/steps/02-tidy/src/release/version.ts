export function nextVersion(current: string): string {
  const [major = 0, minor = 0] = current.split('.').map(Number);
  if (Number.isNaN(major) || Number.isNaN(minor)) throw new Error(`not a version: ${current}`);
  return `${String(major)}.${String(minor + 1)}.0`;
}

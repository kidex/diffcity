export function sql(strings: TemplateStringsArray): string {
  return strings.join('?') + '2';
}

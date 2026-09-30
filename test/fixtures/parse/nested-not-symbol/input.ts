export function outer(values: number[]) {
  function inner(v: number) {
    return v * 2;
  }
  const alsoInner = (v: number) => v + 1;
  class Local {
    run() {}
  }
  return values.map(inner).map(alsoInner).length + String(new Local()).length;
}

export const toolkit = {
  sharpen(blade: string) {
    return blade;
  },
  polish: (stone: string) => stone,
};

if (globalThis.debugMode) {
  function debugOnly() {}
}

{
  const blockScoped = () => 1;
}

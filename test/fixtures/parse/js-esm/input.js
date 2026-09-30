import { readFile } from 'node:fs/promises';

export async function loadPebbles(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export class PebbleJar {
  #count = 0;
  add = (n = 1) => {
    this.#count += n;
  };
  get size() {
    return this.#count;
  }
}

export const JAR_LIMIT = 40;
const shake = (jar) => jar.size;
export default shake;

#!/usr/bin/env node
// Sets the executable bit on every `bin` entry of package.json after tsc has
// written it (tsc writes 0644), so a linked or global `diffcity` keeps working
// after a rebuild.
import { chmodSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {});

for (const bin of bins) chmodSync(join(root, bin), 0o755);

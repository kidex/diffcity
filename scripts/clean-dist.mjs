#!/usr/bin/env node
// Removes dist/ before a build, so a renamed or deleted source file leaves no
// orphan .js behind in the package.
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(join(root, 'dist'), { recursive: true, force: true });

// vitest setupFiles entry (ADR-015): runs before every test file and points
// DIFFCITY_HOME and HOME at a fresh temporary directory, so a test that forgets
// to pass a home still cannot reach the real ~/.config/diffcity. Processes the
// tests spawn inherit both variables through process.env.

import { afterAll } from 'vitest';
import { HOME_ENV } from '../../src/core/home.js';
import { tempHome } from '../helpers/config.js';

const original = { home: process.env[HOME_ENV], userHome: process.env.HOME };
const temp = await tempHome();

process.env[HOME_ENV] = temp.home;
process.env.HOME = temp.userHome;

afterAll(async () => {
  restore(HOME_ENV, original.home);
  restore('HOME', original.userHome);
  await temp.cleanup();
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

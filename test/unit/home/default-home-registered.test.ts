import { describe, expect, it } from 'vitest';
import { HOME_ENV } from '../../../src/core/home.js';
import { registeredHere } from '../../helpers/daemons.js';

describe('DC-58 default test home', () => {
  it('the per-file DIFFCITY_HOME of the setup is registered for the sweep', () => {
    const home = process.env[HOME_ENV];
    expect(home).toBeDefined();
    expect(registeredHere().homes).toContain(home);
  });
});

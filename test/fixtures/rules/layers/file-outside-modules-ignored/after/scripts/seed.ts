import { runCli } from '../src/cli/run.js';
import { missing } from './nowhere.js';

export const seed = runCli([]) + missing;

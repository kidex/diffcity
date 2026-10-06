import { secret } from '../../outside/secret';
import { passwd } from '/etc/passwd';
import { leak } from '@out/leak';
import { local } from './local';

export function run(): unknown {
  return [secret(), passwd(), leak(), local(), 1];
}

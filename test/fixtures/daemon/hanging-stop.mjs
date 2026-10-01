// A daemon whose only plugin never finishes stopping: proves the shutdown
// deadline (argv[2], in ms) and the forced exit on a second signal. Runs the
// built daemon from dist/ like the real script does.
import { runDaemon } from '../../../dist/daemon/run.js';

const stopTimeoutMs = Number(process.argv[2] ?? '10000');
let keepAlive;
const plugin = {
  name: 'hanging',
  start: () => {
    keepAlive = setInterval(() => undefined, 1000);
  },
  stop: () => new Promise(() => undefined),
};

const code = await runDaemon(
  { port: 0, plugins: [plugin], stopTimeoutMs },
  {
    err: (text) => process.stderr.write(text),
    onReady: () => {
      process.stdout.write('ready\n');
    },
  },
);
clearInterval(keepAlive);
process.exit(code);

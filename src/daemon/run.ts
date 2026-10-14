import { DaemonService } from './index.js';

const service = new DaemonService();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void service.stop().catch(() => { process.exitCode = 1; }); });
}
await service.start().catch(() => {
  process.stderr.write('Daemon could not start its local control endpoint.\n');
  process.exitCode = 1;
});

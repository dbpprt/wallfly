import { DaemonService } from './index.js';
import { loadSendConfig } from '../send/config.js';

const service = new DaemonService(loadSendConfig());
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void service.stop().catch(() => { process.exitCode = 1; }); });
}
await service.start().catch(() => {
  process.stderr.write('Daemon could not start its local control endpoint.\n');
  process.exitCode = 1;
});

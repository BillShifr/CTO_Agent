import { OneCAgent } from './agent.js';
import { loadConfig } from './load-config.js';
import { acquireAgentRuntimeLock } from './runtime-guard.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
const config = await loadConfig();
const runtimeLock = await acquireAgentRuntimeLock(config.stateDir);
try {
  await new OneCAgent(config).run(controller.signal);
} finally {
  await runtimeLock.release();
}

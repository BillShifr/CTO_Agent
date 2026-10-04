import { OneCAgent } from './agent.js';
import { loadConfig } from './load-config.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
await new OneCAgent(await loadConfig()).run(controller.signal);

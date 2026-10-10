import { OneCAgent } from './agent.js';
import { diagnosticsSucceeded, runAgentDiagnostics } from './diagnostics.js';
import { loadConfig } from './load-config.js';
import { acquireAgentRuntimeLock } from './runtime-guard.js';

const diagnosticMode = process.argv.includes('--diagnose');
const offline = process.argv.includes('--offline');
if (offline && !diagnosticMode) throw new Error('--offline is only valid with --diagnose');
if (process.argv.slice(2).some((argument) => !['--diagnose', '--offline'].includes(argument)))
  throw new Error('supported arguments: --diagnose [--offline]');

const config = await loadConfig();
if (diagnosticMode) {
  const checks = await runAgentDiagnostics(config, { network: !offline });
  process.stdout.write(`${JSON.stringify({ ok: diagnosticsSucceeded(checks), checks })}\n`);
  if (!diagnosticsSucceeded(checks)) process.exitCode = 1;
} else {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  const runtimeLock = await acquireAgentRuntimeLock(config.stateDir);
  try {
    await new OneCAgent(config).run(controller.signal);
  } finally {
    await runtimeLock.release();
  }
}

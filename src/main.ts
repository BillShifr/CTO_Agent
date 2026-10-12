import { OneCAgent } from './agent.js';
import { readFile } from 'node:fs/promises';
import { configureMappings } from './mappings.js';
import { configureMappingsInteractively } from './mapping-console.js';
import { diagnosticsSucceeded, runAgentDiagnostics } from './diagnostics.js';
import { loadConfig } from './load-config.js';
import { acquireAgentRuntimeLock } from './runtime-guard.js';

const diagnosticMode = process.argv.includes('--diagnose');
const mappingMode = process.argv[2] === '--mappings';
const mappingWizard = process.argv[2] === '--configure-mappings' && process.argv.length === 3;
const argumentsToValidate = mappingMode || mappingWizard ? [] : process.argv.slice(2);
if (mappingMode && (process.argv.length > 4 || process.argv[3]?.startsWith('--')))
  throw new Error('supported arguments: --mappings [request.json]');
const offline = process.argv.includes('--offline');
if (offline && !diagnosticMode) throw new Error('--offline is only valid with --diagnose');
if (argumentsToValidate.some((argument) => !['--diagnose', '--offline'].includes(argument)))
  throw new Error('supported arguments: --diagnose [--offline]');

const config = await loadConfig();
if (mappingWizard) {
  await configureMappingsInteractively(config);
} else if (mappingMode) {
  const file = process.argv[3];
  const input: unknown = file === undefined ? undefined : JSON.parse(await readFile(file, 'utf8'));
  process.stdout.write(`${JSON.stringify(await configureMappings(config, input), null, 2)}\n`);
} else if (diagnosticMode) {
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

import { createInterface } from 'node:readline/promises';
import type { AgentConfig } from './config.js';
import { runMappingWizard } from './mapping-wizard.js';

export async function configureMappingsInteractively(config: AgentConfig) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('--configure-mappings requires an interactive terminal');
  const console = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await runMappingWizard(config, {
      ask: (message) => console.question(message),
      write: (message) => process.stdout.write(`${message}\n`),
    });
  } finally {
    console.close();
  }
}

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { readConfig } from './config.js';

/** The Windows service explicitly loads its ACL-protected file, never SCM's stale environment. */
export async function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  try {
    if (!environment.AVTOPULT_AGENT_CONFIG_FILE) return readConfig(environment);
    const contents = await readFile(environment.AVTOPULT_AGENT_CONFIG_FILE, 'utf8');
    const values = z.record(z.string(), z.string()).parse(JSON.parse(contents));
    return readConfig(values);
  } catch {
    // Do not print Zod/JSON errors containing secret-bearing configuration input.
    throw new Error('Cannot load agent configuration; check file access and required settings');
  }
}

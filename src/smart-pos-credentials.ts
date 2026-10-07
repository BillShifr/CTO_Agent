import { join } from 'node:path';
import { z } from 'zod';
import type { AgentConfig } from './config.js';
import { readPrivateJson, writePrivateJson } from './private-json-file.js';

const credentialsSchema = z
  .object({
    accessToken: z.string().min(16),
    refreshToken: z.string().min(16),
  })
  .strict();

export type SmartPosCredentials = z.infer<typeof credentialsSchema>;

export class SmartPosCredentialStore {
  private readonly file: string;

  constructor(private readonly config: AgentConfig) {
    this.file = join(config.stateDir, 'smart-pos-credentials.json');
  }

  async read(): Promise<SmartPosCredentials> {
    const saved = await readPrivateJson(this.file, (value) => credentialsSchema.parse(value));
    if (saved !== undefined) return saved;
    const smartPos = this.config.smartPos;
    if (smartPos === undefined) throw new Error('Kaspi Smart POS is not configured');
    const initial = { accessToken: smartPos.token, refreshToken: smartPos.refreshToken };
    await this.write(initial);
    return initial;
  }

  async write(value: SmartPosCredentials): Promise<void> {
    await writePrivateJson(this.file, credentialsSchema.parse(value));
  }
}

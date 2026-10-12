import { oneCMappingsUpdateSchema, oneCMappingsResponseSchema } from './protocol/one-c-mappings.js';
import type { AgentConfig } from './config.js';
import { boundedFetch, json } from './http.js';

/** Uses the enrolled agent identity; company and connection are never supplied by the caller. */
export async function configureMappings(config: AgentConfig, input?: unknown) {
  const url = new URL('mappings', config.cloudUrl);
  const headers = {
    'x-onec-agent-id': config.agentId,
    'x-onec-secret': config.secret,
    'content-type': 'application/json',
  };
  if (input !== undefined) {
    const update = oneCMappingsUpdateSchema.parse(input);
    const response = await boundedFetch(config, url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(update),
    });
    if (!response.ok) throw new Error(`Mapping update failed: HTTP ${response.status}`);
    const saved = oneCMappingsResponseSchema.parse(await json(response));
    const read = await boundedFetch(config, url, { headers });
    if (!read.ok) throw new Error(`Mapping verification failed: HTTP ${read.status}`);
    const verified = oneCMappingsResponseSchema.parse(await json(read));
    if (verified.revision !== saved.revision)
      throw new Error('Mappings changed during verification; read them again');
    return verified;
  }
  const response = await boundedFetch(config, url, { headers });
  if (!response.ok) throw new Error(`Mapping read failed: HTTP ${response.status}`);
  return oneCMappingsResponseSchema.parse(await json(response));
}

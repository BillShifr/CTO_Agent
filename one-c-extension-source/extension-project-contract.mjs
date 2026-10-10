import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = fileURLToPath(new URL('.', import.meta.url));

export function requiredExtensionProjectPaths(manifest) {
  return [
    'Configuration.xml',
    ...manifest.commonModules.flatMap(({ name }) => [
      `CommonModules/${name}.xml`,
      `CommonModules/${name}/Ext/Module.bsl`,
    ]),
    ...manifest.httpServices.flatMap((name) => [
      `HTTPServices/${name}.xml`,
      `HTTPServices/${name}/Ext/Module.bsl`,
    ]),
    ...manifest.informationRegisters.map((name) => `InformationRegisters/${name}.xml`),
    ...manifest.eventSubscriptions.map((name) => `EventSubscriptions/${name}.xml`),
    ...manifest.roles.map((name) => `Roles/${name}.xml`),
  ];
}

export async function verifyExtensionProject(projectDirectory) {
  const manifest = JSON.parse(
    await readFile(resolve(sourceDirectory, 'extension-project-manifest.json'), 'utf8'),
  );
  const failures = [];
  const required = requiredExtensionProjectPaths(manifest);

  for (const relativePath of required) {
    try {
      const file = await stat(resolve(projectDirectory, relativePath));
      if (!file.isFile() || file.size === 0) failures.push(relativePath);
    } catch {
      failures.push(relativePath);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Exported 1C extension project is incomplete; missing:\n${failures
        .map((name) => `- ${name}`)
        .join('\n')}`,
    );
  }

  return { manifest, required };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const projectDirectory = process.argv[2];
  if (!projectDirectory) {
    console.error('Usage: node extension-project-contract.mjs <exported-extension-directory>');
    process.exitCode = 2;
  } else {
    try {
      const result = await verifyExtensionProject(resolve(projectDirectory));
      console.log(
        `Verified ${result.manifest.extensionName}: ${result.required.length} required project files`,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

import type { AgentConfig } from './config.js';
import { configureMappings } from './mappings.js';
import { readMappingCatalog, type MappingEntry } from './mapping-catalogs.js';

export interface MappingPrompt {
  ask(message: string): Promise<string>;
  write(message: string): void;
}

async function choose(io: MappingPrompt, title: string, entries: MappingEntry[], fixed?: string) {
  if (fixed !== undefined) {
    const current = entries.find((entry) => entry.Ref_Key === fixed);
    if (!current) throw new Error(`Existing mapping not found in 1C: ${title}`);
    io.write(`${title}: ${current.Description} (сохранено)`);
    return current.Ref_Key;
  }
  io.write(title);
  entries.forEach((entry, index) =>
    io.write(`${index + 1}. ${entry.Description} [${entry.Ref_Key}]`),
  );
  const answer = (await io.ask('Номер (Enter — отмена): ')).trim();
  if (!/^\d+$/.test(answer)) throw new Error('Выбор отменён; ничего не сохранено');
  const selected = entries[Number(answer) - 1];
  if (!selected) throw new Error('Неверный номер; ничего не сохранено');
  io.write(`Выбрано: ${selected.Description}`);
  return selected.Ref_Key;
}

/** Reads both systems first; the only write follows explicit operator confirmation. */
export async function runMappingWizard(config: AgentConfig, io: MappingPrompt) {
  const state = await configureMappings(config);
  if (state.targets.length === 0) throw new Error('Сначала создайте СТО и склады в приложении');
  const organizations = await readMappingCatalog(config, 'Организации');
  const warehouses = await readMappingCatalog(config, 'Склады');
  const prices = await readMappingCatalog(config, 'ВидыЦен');
  const organizationExternalId = await choose(
    io,
    'Организация',
    organizations,
    state.mappings?.organizationExternalId,
  );
  const productRetailPriceTypeId = await choose(io, 'Цена товаров', prices);
  const serviceRetailPriceTypeId = await choose(io, 'Цена услуг', prices);
  const purchasePriceTypeId = await choose(io, 'Закупочная цена', prices);
  const selected = [];
  for (const target of state.targets) {
    const fixed = state.mappings?.warehouses.find(
      (item) => item.warehouseId === target.warehouseId,
    )?.externalId;
    const externalId = await choose(
      io,
      `${target.stationName} / ${target.warehouseName}`,
      warehouses,
      fixed,
    );
    selected.push({ warehouseId: target.warehouseId, externalId });
  }
  const hours = await io.ask('Норма часов услуги без норматива (0–1000): ');
  if (!/^\d+(?:[.,]\d+)?$/.test(hours.trim()))
    throw new Error('Неверная норма часов; ничего не сохранено');
  const mappings = {
    organizationExternalId,
    productRetailPriceTypeId,
    serviceRetailPriceTypeId,
    purchasePriceTypeId,
    defaultServiceNormHours: Number(hours.trim().replace(',', '.')),
    warehouses: selected,
  };
  io.write('Выбранные соответствия будут сохранены в СТО. Документы 1С не изменяются.');
  if ((await io.ask('Сохранить? Введите ДА: ')).trim() !== 'ДА') return false;
  await configureMappings(config, { expectedRevision: state.revision, mappings });
  io.write('Сохранено и проверено чтением из СТО. Профили документов настраиваются в 1С отдельно.');
  return true;
}

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const BASE_METADATA_REQUIREMENTS = Object.freeze({
  Catalog_Номенклатура: ['Ref_Key', 'DeletionMark', 'IsFolder'],
  Catalog_Партнеры: ['Ref_Key', 'DeletionMark'],
  Catalog_Контрагенты: ['Ref_Key', 'DeletionMark', 'Партнер_Key'],
  Catalog_Автомобили: ['Ref_Key', 'DeletionMark'],
  Document_ЗаказКлиента: [
    'Ref_Key',
    'DataVersion',
    'DeletionMark',
    'Posted',
    'Партнер_Key',
    'Контрагент_Key',
    'Организация_Key',
    'Соглашение_Key',
    'Валюта_Key',
    'СуммаДокумента',
    'Склад_Key',
    'ЦенаВключаетНДС',
    'Статус',
    'МаксимальныйКодСтроки',
    'ФормаОплаты',
    'НалогообложениеНДС',
    'ХозяйственнаяОперация',
    'Подразделение_Key',
    'ПорядокРасчетов',
    'Автомобиль_Key',
    'Товары',
  ],
  Document_ЗаказКлиента_Товары: [
    'Ref_Key',
    'LineNumber',
    'Номенклатура_Key',
    'КоличествоУпаковок',
    'Количество',
    'ВидЦены_Key',
    'Цена',
    'Сумма',
    'СтавкаНДС_Key',
    'СуммаНДС',
    'СуммаСНДС',
    'КодСтроки',
    'Отменено',
    'Склад_Key',
    'ВариантОбеспечения',
  ],
  Document_СчетНаОплатуКлиенту: [
    'Ref_Key',
    'DataVersion',
    'DeletionMark',
    'Posted',
    'Организация_Key',
    'СуммаДокумента',
    'Валюта_Key',
    'ДокументОснование',
    'Аннулирован',
    'Партнер_Key',
    'Контрагент_Key',
    'ЭтапыГрафикаОплаты',
    'ДокументОснование_Type',
  ],
  Document_СчетНаОплатуКлиенту_ЭтапыГрафикаОплаты: [
    'Ref_Key',
    'LineNumber',
    'ДатаПлатежа',
    'ПроцентПлатежа',
    'СуммаПлатежа',
  ],
  Document_ПриходныйКассовыйОрдер: settlementDocumentProperties(),
  Document_ПоступлениеБезналичныхДенежныхСредств: settlementDocumentProperties(),
  Document_ОперацияПоПлатежнойКарте: settlementDocumentProperties(),
  Document_РасходныйКассовыйОрдер: settlementDocumentProperties(),
  Document_СписаниеБезналичныхДенежныхСредств: settlementDocumentProperties(),
  Document_ПриходныйКассовыйОрдер_РасшифровкаПлатежа: incomingAllocationProperties(),
  Document_ПоступлениеБезналичныхДенежныхСредств_РасшифровкаПлатежа: incomingAllocationProperties(),
  Document_ОперацияПоПлатежнойКарте_РасшифровкаПлатежа: incomingAllocationProperties(),
  Document_РасходныйКассовыйОрдер_РасшифровкаПлатежа: outgoingAllocationProperties(),
  Document_СписаниеБезналичныхДенежныхСредств_РасшифровкаПлатежа: outgoingAllocationProperties(),
});

export const POSTABLE_DOCUMENTS = Object.freeze([
  'Document_ЗаказКлиента',
  'Document_СчетНаОплатуКлиенту',
  'Document_ПриходныйКассовыйОрдер',
  'Document_ПоступлениеБезналичныхДенежныхСредств',
  'Document_ОперацияПоПлатежнойКарте',
  'Document_РасходныйКассовыйОрдер',
  'Document_СписаниеБезналичныхДенежныхСредств',
]);

function settlementDocumentProperties() {
  return [
    'Ref_Key',
    'DataVersion',
    'DeletionMark',
    'Posted',
    'СуммаДокумента',
    'ХозяйственнаяОперация',
    'РасшифровкаПлатежа',
  ];
}

function incomingAllocationProperties() {
  return [
    'Ref_Key',
    'LineNumber',
    'ОснованиеПлатежа',
    'Заказ',
    'Сумма',
    'СуммаВзаиморасчетов',
    'ОснованиеПлатежа_Type',
    'Заказ_Type',
  ];
}

function outgoingAllocationProperties() {
  return ['Ref_Key', 'LineNumber', 'Заказ', 'Сумма', 'СуммаВзаиморасчетов', 'Заказ_Type'];
}

function decodeXml(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function attribute(attributes, name) {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)')`));
  return match ? decodeXml(match[1] ?? match[2]) : undefined;
}

export function inspectMetadata(xml) {
  const entityTypes = new Map();
  const entityPattern = /<(?:\w+:)?EntityType\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?EntityType>/g;
  for (const match of xml.matchAll(entityPattern)) {
    const name = attribute(match[1], 'Name');
    if (!name) continue;
    const properties = new Set();
    const propertyPattern = /<(?:\w+:)?Property\b([^>]*)\/?\s*>/g;
    for (const property of match[2].matchAll(propertyPattern)) {
      const propertyName = attribute(property[1], 'Name');
      if (propertyName) properties.add(propertyName);
    }
    entityTypes.set(name, properties);
  }

  const functionsByBinding = new Map();
  const functionPattern =
    /<(?:\w+:)?FunctionImport\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?FunctionImport>/g;
  for (const match of xml.matchAll(functionPattern)) {
    const functionName = attribute(match[1], 'Name');
    if (!functionName) continue;
    const parameterPattern = /<(?:\w+:)?Parameter\b([^>]*)\/?\s*>/g;
    for (const parameter of match[2].matchAll(parameterPattern)) {
      if (attribute(parameter[1], 'Name') !== 'bindingParameter') continue;
      const type = attribute(parameter[1], 'Type') ?? '';
      const binding = type.split('.').at(-1);
      if (!binding) continue;
      const functions = functionsByBinding.get(binding) ?? new Set();
      functions.add(functionName);
      functionsByBinding.set(binding, functions);
    }
  }

  return { entityTypes, functionsByBinding };
}

export function verifyMetadata(xml) {
  const { entityTypes, functionsByBinding } = inspectMetadata(xml);
  const problems = [];
  for (const [entityName, requiredProperties] of Object.entries(BASE_METADATA_REQUIREMENTS)) {
    const actualProperties = entityTypes.get(entityName);
    if (!actualProperties) {
      problems.push({ kind: 'missing-entity', entity: entityName });
      continue;
    }
    for (const property of requiredProperties) {
      if (!actualProperties.has(property)) {
        problems.push({ kind: 'missing-property', entity: entityName, property });
      }
    }
  }

  for (const entityName of POSTABLE_DOCUMENTS) {
    const functions = functionsByBinding.get(entityName) ?? new Set();
    for (const functionName of ['Post', 'Unpost']) {
      if (!functions.has(functionName)) {
        problems.push({ kind: 'missing-function', entity: entityName, function: functionName });
      }
    }
  }

  return {
    ok: problems.length === 0,
    checkedEntities: Object.keys(BASE_METADATA_REQUIREMENTS).length,
    checkedPostableDocuments: POSTABLE_DOCUMENTS.length,
    problems,
  };
}

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: node base-metadata-contract.mjs <metadata.xml>');
    process.exitCode = 2;
    return;
  }
  const bytes = await readFile(path);
  const xml = bytes.toString('utf8');
  const result = verifyMetadata(xml);
  const report = {
    ...result,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  console.log(JSON.stringify(report, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

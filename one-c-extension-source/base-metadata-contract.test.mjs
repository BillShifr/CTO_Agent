import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BASE_METADATA_REQUIREMENTS,
  POSTABLE_DOCUMENTS,
  inspectMetadata,
  verifyMetadata,
} from './base-metadata-contract.mjs';

function completeMetadata() {
  const entities = Object.entries(BASE_METADATA_REQUIREMENTS)
    .map(
      ([name, properties]) =>
        `<EntityType Name="${name}">${properties
          .map((property) => `<Property Name="${property}" Type="Edm.String" />`)
          .join('')}</EntityType>`,
    )
    .join('');
  const functions = POSTABLE_DOCUMENTS.flatMap((entity) =>
    ['Post', 'Unpost'].map(
      (name) =>
        `<FunctionImport Name="${name}"><Parameter Name="bindingParameter" Type="StandardODATA.${entity}" /></FunctionImport>`,
    ),
  ).join('');
  return `<edmx:Edmx><Schema>${entities}${functions}</Schema></edmx:Edmx>`;
}

test('accepts every base entity, field and posting action used by the adapter', () => {
  const result = verifyMetadata(completeMetadata());
  assert.deepEqual(result, {
    ok: true,
    checkedEntities: Object.keys(BASE_METADATA_REQUIREMENTS).length,
    checkedPostableDocuments: POSTABLE_DOCUMENTS.length,
    problems: [],
  });
});

test('reports a removed field and posting action without reading business data', () => {
  const xml = completeMetadata()
    .replace('<Property Name="Автомобиль_Key" Type="Edm.String" />', '')
    .replace(
      '<FunctionImport Name="Post"><Parameter Name="bindingParameter" Type="StandardODATA.Document_ЗаказКлиента" /></FunctionImport>',
      '',
    );
  const result = verifyMetadata(xml);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [
    {
      kind: 'missing-property',
      entity: 'Document_ЗаказКлиента',
      property: 'Автомобиль_Key',
    },
    {
      kind: 'missing-function',
      entity: 'Document_ЗаказКлиента',
      function: 'Post',
    },
  ]);
});

test('parser accepts namespace-prefixed metadata tags and escaped attributes', () => {
  const metadata = inspectMetadata(
    '<edm:EntityType Name="A&amp;B"><edm:Property Name="Поле" /></edm:EntityType>',
  );
  assert.deepEqual([...metadata.entityTypes.keys()], ['A&B']);
  assert.deepEqual([...metadata.entityTypes.get('A&B')], ['Поле']);
});

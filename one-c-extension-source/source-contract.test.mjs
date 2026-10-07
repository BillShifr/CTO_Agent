import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const moduleSource = await readFile(
  new URL('./src/CommonModules/AvtoPultIntegration/Module.bsl', import.meta.url),
  'utf8',
);
const httpSource = await readFile(
  new URL('./src/HTTPServices/AvtoPult/Module.bsl', import.meta.url),
  'utf8',
);

test('local outbox exposes every endpoint consumed by the Windows agent', () => {
  for (const handler of [
    'EventsClaimPOST',
    'EventsAckPOST',
    'InvoiceDocumentsClaimPOST',
    'InvoiceDocumentContentGET',
    'InvoiceDocumentAckPOST',
  ]) {
    assert.match(httpSource, new RegExp(`Функция ${handler}\\(`));
  }

  for (const operation of [
    'ПолучитьИсходящиеСобытия',
    'ПолучитьИсходящиеДокументы',
    'ПодтвердитьИсходящийОбъект',
    'ПолучитьСодержимоеДокумента',
  ]) {
    assert.match(moduleSource, new RegExp(`Функция ${operation}\\([^)]*\\) Экспорт`));
  }
});

test('payroll export is routed only to the local configuration adapter', () => {
  assert.match(httpSource, /Функция PayrollPeriodsPOST\(/);
  assert.match(moduleSource, /AvtoPultАдаптерКА2\.ПрименитьНачисления/);
});

test('outbox source keeps delivery durable and token fenced', () => {
  assert.match(moduleSource, /Состояние <> "leased"/);
  assert.match(moduleSource, /Запись\.LeaseToken <> LeaseToken/);
  assert.match(moduleSource, /Запись\.LeaseUntil < ТекущаяУниверсальнаяДата\(\)/);
  assert.match(moduleSource, /Новый УникальныйИдентификатор\(\)/);
  assert.match(moduleSource, /ЗаблокироватьИсходящиеОбъекты\(\)/);
  assert.match(moduleSource, /ПоставитьСобытиеВОчердь\([^)]*\) Экспорт/);
  assert.match(moduleSource, /ПоставитьPDFСчетаВОчердь\([^)]*\) Экспорт/);
});

test('write idempotency is fenced before the configuration adapter is invoked', () => {
  const handlerStart = moduleSource.indexOf('Функция ОбработатьИзменение(');
  const handlerEnd = moduleSource.indexOf('КонецФункции', handlerStart);
  const handler = moduleSource.slice(handlerStart, handlerEnd);
  const transaction = handler.indexOf('НачатьТранзакцию()');
  const lock = handler.indexOf('ЗаблокироватьРезультат(Ключ)');
  const replayRead = handler.indexOf('Повтор = НайтиРезультат(Ключ)');
  const businessEffect = handler.indexOf('AvtoPultАдаптерКА2.ПрименитьЗаказКлиента');

  assert.ok(transaction >= 0);
  assert.ok(transaction < lock);
  assert.ok(lock < replayRead);
  assert.ok(replayRead < businessEffect);
  assert.match(moduleSource, /ЭлементБлокировки\.УстановитьЗначение\("Ключ", Ключ\)/);
  assert.match(handler, /Повтор\.Операция <> Операция Или Повтор\.ХешЗапроса <> Хеш/);
  assert.match(handler, /КлючИдемпотентностиДопустим\(Ключ\)/);
  assert.match(moduleSource, /СтрДлина\(Ключ\) < 8 Или СтрДлина\(Ключ\) > 135/);
  assert.match(
    moduleSource,
    /ДопустимыеСимволы = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-"/,
  );
  assert.match(handler, /REQUEST_BODY_INVALID/);
  assert.match(handler, /ПрименитьЗаказКлиента\(Payload\)/);
  assert.match(handler, /КодУспеха = \?\(Операция = "invoices", 202, 200\)/);
  assert.match(
    handler,
    /ПодготовленныйОтвет = ПодготовитьОтветАдаптера\(ОтветАдаптера, КодУспеха\)/,
  );
  assert.match(handler, /ПодготовленныйОтвет\.КодHTTP/);
  assert.match(handler, /ПодготовленныйОтвет\.Тело/);
});

test('configuration adapter has a fail-closed typed business-error boundary', () => {
  assert.match(moduleSource, /ОтветАдаптера\.Свойство\("Успех", Успех\)/);
  assert.match(moduleSource, /ОтветАдаптера\.Свойство\("Данные", Данные\)/);
  for (const field of ['КодHTTP', 'Код', 'Сообщение', 'Повторяемая'])
    assert.match(moduleSource, new RegExp(`ОтветАдаптера\\.Свойство\\("${field}"`));
  assert.match(moduleSource, /Если Повторяемая Тогда/);
  assert.match(moduleSource, /КодHTTP = 423 Или КодHTTP = 429/);
  assert.match(moduleSource, /КодHTTP = 400 Или КодHTTP = 403/);
  assert.match(moduleSource, /ОтветАдаптера\.Свойство\("ТекущаяВерсия", ТекущаяВерсия\)/);
  assert.match(moduleSource, /Проблема\.Вставить\("currentVersion", ТекущаяВерсия\)/);
  assert.match(moduleSource, /ВызватьИсключение "Адаптер вернул недопустимую бизнес-ошибку"/);
});

test('outbox creation locks before checking and writing an event id', () => {
  const createStart = moduleSource.indexOf('Процедура СохранитьНовыйИсходящийОбъект(');
  const createEnd = moduleSource.indexOf('КонецПроцедуры', createStart);
  const create = moduleSource.slice(createStart, createEnd);

  assert.ok(create.indexOf('ЗаблокироватьИсходящиеОбъекты()') >= 0);
  assert.ok(
    create.indexOf('ЗаблокироватьИсходящиеОбъекты()') <
      create.indexOf('НайтиИсходящийОбъект(EventId, Вид)'),
  );
});

test('extension does not return raw 1C exception descriptions', () => {
  assert.doesNotMatch(moduleSource, /ОписаниеОшибки\(\)/);
});

test('missing optional headers are normalized before string operations', () => {
  assert.match(
    moduleSource,
    /Ключ = НормализоватьСтроку\(Запрос\.Заголовки\.Получить\("Idempotency-Key"\)\)/,
  );
  assert.match(
    moduleSource,
    /LeaseToken = НормализоватьСтроку\(Запрос\.Заголовки\.Получить\("X-AvtoPult-Lease-Token"\)\)/,
  );
  assert.match(moduleSource, /Если Значение = Неопределено Тогда/);
});

test('every local endpoint is contract-versioned and PDF responses cannot be cached', () => {
  assert.match(
    moduleSource,
    /НормализоватьСтроку\(Запрос\.Заголовки\.Получить\("X-AvtoPult-Contract-Version"\)\)/,
  );
  assert.match(moduleSource, /Функция ПолучитьИсходящиеСобытия\(Запрос\) Экспорт/);
  assert.match(moduleSource, /Функция ПолучитьИсходящиеДокументы\(Запрос\) Экспорт/);
  assert.match(moduleSource, /Функция ПолучитьСодержимоеДокумента\(EventId, Запрос\) Экспорт/);
  assert.match(moduleSource, /Ответ\.Заголовки\.Вставить\("Cache-Control", "private, no-store"\)/);
  assert.match(httpSource, /ПолучитьИсходящиеСобытия\(Запрос\)/);
  assert.match(httpSource, /ПолучитьИсходящиеДокументы\(Запрос\)/);
});

test('extension source contains no direct cloud or VPN transport', () => {
  assert.doesNotMatch(moduleSource, /Radmin|https?:\/\//i);
  assert.doesNotMatch(httpSource, /Radmin|https?:\/\//i);
});

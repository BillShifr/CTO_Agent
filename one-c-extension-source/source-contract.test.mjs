import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
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

test('native claims retain leased heads and order by durable insertion sequence', () => {
  const start = moduleSource.indexOf('Функция ПолучитьИсходящиеОбъекты(');
  const body = moduleSource.slice(start, moduleSource.indexOf('КонецФункции', start));
  assert.match(body, /Очередь\.Состояние <> &Доставлено/);
  assert.match(body, /УПОРЯДОЧИТЬ ПО Очередь\.Порядок/);
  assert.doesNotMatch(body, /ВЫБРАТЬ ПЕРВЫЕ/);
  assert.match(body, /ЭтоДоступнаяГолова\(Выборка, Заказы, Сейчас\)/);
  assert.match(body, /Элементы\.Количество\(\) >= Лимит/);
  const headStart = moduleSource.indexOf('Функция ЭтоДоступнаяГолова(');
  const head = moduleSource.slice(headStart, moduleSource.indexOf('КонецФункции', headStart));
  assert.ok(head.indexOf('Заказы.Вставить') < head.indexOf('Запись.LeaseUntil'));
  assert.match(head, /OUTBOX_ORDERING_MIGRATION_REQUIRED/);
  for (const field of ['Порядок', 'КлючЗаказа']) {
    assert.match(moduleSource, new RegExp(`НоваяЗапись\\.${field} = Запись\\.${field}`));
  }
  assert.match(moduleSource, /Запись\.Порядок = СледующийПорядокОчереди\(\)/);
});

test('order ACK persists the validated cloud result in the delivery transaction', () => {
  const start = moduleSource.indexOf('Функция ПодтвердитьИсходящийОбъект(');
  const body = moduleSource.slice(start, moduleSource.indexOf('КонецФункции', start));
  const write = body.indexOf('ЗаписатьСостояниеИсходящегоОбъекта(Запись, "delivered"');
  for (const guard of ['RESULT_VERSION_REQUIRED', 'RESULT_VERSION_INVALID']) {
    assert.ok(body.indexOf(guard) > 0 && body.indexOf(guard) < write);
  }
  assert.match(body, /ВерсияОблака <= Событие\.baseVersion/);
  assert.match(body, /Неопределено, ВерсияОблака\)/);
  assert.ok(write < body.indexOf('ЗафиксироватьТранзакцию()'));
  assert.match(moduleSource, /НоваяЗапись\.РезультатВерсияЗаказа =/);
  assert.match(moduleSource, /Запись\.РезультатВерсияЗаказа, ВерсияОблака/);
});

test('all native producers require a transaction and matching envelope identity before locking', () => {
  const start = moduleSource.indexOf('Процедура СохранитьНовыйИсходящийОбъект(');
  const body = moduleSource.slice(start, moduleSource.indexOf('КонецПроцедуры', start));
  const lock = body.indexOf('ЗаблокироватьИсходящиеОбъекты()');
  for (const guard of ['TRANSACTION_REQUIRED', 'OUTBOX_EVENT_ID_MISMATCH']) {
    assert.ok(body.indexOf(guard) >= 0, `missing ${guard}`);
    assert.ok(body.indexOf(guard) < lock, `${guard} must precede lock/write`);
  }
  assert.match(body, /Не ТранзакцияАктивна\(\)/);
  assert.match(body, /Payload\.Свойство\("eventId", ИдентификаторТела\)/);
  assert.match(body, /ИдентификаторТела <> EventId/);
  assert.doesNotMatch(body, /НачатьТранзакцию\(|ЗафиксироватьТранзакцию\(/);
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

test('controlled failures roll back business writes before deciding whether to cache', () => {
  const start = moduleSource.indexOf('Функция ОбработатьИзменение(');
  const handler = moduleSource.slice(start, moduleSource.indexOf('КонецФункции', start));
  const failure = handler.indexOf('Если Не ОтветАдаптера.Успех Тогда');
  const rollback = handler.indexOf('ОтменитьТранзакцию()', failure);
  const retry = handler.indexOf('Если ОтветАдаптера.Повторяемая Тогда', failure);
  const terminal = handler.indexOf('СохранитьТерминальнуюОшибку(', failure);
  assert.ok(failure > 0);
  assert.ok(failure < rollback && rollback < retry && retry < terminal);
  assert.match(handler.slice(retry, terminal), /Возврат JSONОтвет/);
});

test('terminal failure reacquires the delivery lock and never overwrites a concurrent result', () => {
  const start = moduleSource.indexOf('Функция СохранитьТерминальнуюОшибку(');
  assert.ok(start >= 0);
  const handler = moduleSource.slice(start, moduleSource.indexOf('КонецФункции', start));
  const lock = handler.indexOf('ЗаблокироватьРезультат(Ключ)');
  const read = handler.indexOf('Повтор = НайтиРезультат(Ключ)');
  const write = handler.indexOf('СохранитьРезультат(');
  assert.ok(handler.indexOf('НачатьТранзакцию()') < lock);
  assert.ok(lock >= 0 && lock < read && read < write);
  assert.match(
    handler.slice(read, write),
    /Повтор\.Операция <> Операция Или Повтор\.ХешЗапроса <> Хеш/,
  );
  assert.match(handler.slice(read, write), /Возврат СохраненныйОтвет\(Повтор\)/);
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

test('request hashing does not depend on the missing configuration adapter', () => {
  assert.doesNotMatch(moduleSource, /AvtoPultАдаптерКА2\.SHA256/);
  assert.match(moduleSource, /Новый ХешированиеДанных\(ХешФункция\.SHA256\)/);
  assert.match(
    moduleSource,
    /ПолучитьДвоичныеДанныеИзСтроки\(Текст, КодировкаТекста\.UTF8, Ложь\)/,
  );
  assert.match(moduleSource, /НРег\(ПолучитьHexСтрокуИзДвоичныхДанных\(Хеширование\.ХешСумма\)\)/);
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

test('JSON objects deserialize as structures used by request and lease handlers', () => {
  const start = moduleSource.indexOf('Функция ПрочитатьТелоJSON(');
  const body = moduleSource.slice(start, moduleSource.indexOf('КонецФункции', start));
  assert.match(body, /ПрочитатьJSON\(Чтение, Ложь\)/);
  assert.doesNotMatch(body, /ПрочитатьJSON\(Чтение, Истина\)/);
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

test('every extension-module call resolves to an implemented exported routine', async () => {
  const root = new URL('./src/CommonModules/', import.meta.url);
  const modules = new Map();
  for (const directory of await readdir(root)) {
    const source = await readFile(new URL(`${directory}/Module.bsl`, root), 'utf8');
    const name = directory === 'AvtoPultIntegration' ? 'AvtoPultИнтеграция' : directory;
    const exports = new Set(
      [...source.matchAll(/(?:Функция|Процедура)\s+([\p{L}\w]+)\([^)]*\)\s+Экспорт/gu)].map(
        (match) => match[1].toLowerCase(),
      ),
    );
    modules.set(name.toLowerCase(), { source, exports });
  }
  for (const { source } of [...modules.values(), { source: httpSource }]) {
    for (const [, name, method] of source.matchAll(
      /(?<![\p{L}\w.])(AvtoPult[\p{L}\w]*)\.([\p{L}\w]+)\(/gu,
    )) {
      assert.ok(
        modules.get(name.toLowerCase())?.exports.has(method.toLowerCase()),
        `Unresolved extension call: ${name}.${method}`,
      );
    }
  }
});

test('native draft writes retain transaction and post-write verification boundaries', async () => {
  const orders = await readFile(
    new URL('./src/CommonModules/AvtoPultЗаказы/Module.bsl', import.meta.url),
    'utf8',
  );
  assert.match(orders, /ТранзакцияАктивна\(\)/);
  assert.match(orders, /AvtoPultКонтракт\.ПроверитьЗаказ\(Payload\)/);
  assert.match(
    orders,
    /AvtoPultИзмененияЗаказов\.ЗаписатьИзОблака\(Документ, Заказ\.version, Payload\)/,
  );
  assert.match(orders, /СохраненныйСоставСовпадает\(/);
  assert.match(orders, /INVOICE_LOCKED/);
  assert.match(orders, /NATIVE_VERSION_CONFLICT/);
  assert.doesNotMatch(orders, /РежимЗаписиДокумента\.Проведение|Загрузка\s*=\s*Истина/);
});

test('invoice source does not acknowledge missing printing and limits binary delivery', async () => {
  const invoices = await readFile(
    new URL('./src/CommonModules/AvtoPultСчета/Module.bsl', import.meta.url),
    'utf8',
  );
  assert.match(invoices, /PRINT_PIPELINE_NOT_CONFIGURED/);
  assert.match(invoices, /10485760/);
  assert.match(invoices, /ПоставитьPDFСчетаВОчердь\(/);
  assert.match(invoices, /УдалитьФайлы\(/);
  assert.doesNotMatch(invoices, /ЗафиксироватьТранзакцию\(|НачатьТранзакцию\(/);
});

test('native order subscription captures immutable revisions without guessing cloud transitions', async () => {
  const source = await readFile(
    new URL('./src/CommonModules/AvtoPultИзмененияЗаказов/Module.bsl', import.meta.url),
    'utf8',
  );
  assert.match(source, /Процедура ПриЗаписиЗаказа\(Источник, Отказ\) Экспорт/);
  assert.match(source, /Не ТранзакцияАктивна\(\)/);
  assert.match(source, /ПредыдущаяРевизия = Голова\.RevisionId/);
  assert.match(source, /Запись\.BaseVersion = Связь\.Версия/);
  assert.match(source, /Запись\.PayloadJSON = СнимокJSON/);
  assert.match(source, /Запись\.Состояние = "pending"/);
  assert.ok(source.indexOf('Запись.Записать()') < source.indexOf('Голова.Записать()'));
  assert.doesNotMatch(
    source,
    /ЗафиксироватьТранзакцию\(|НачатьТранзакцию\(|HTTPСоединение|ПоставитьСобытиеВОчердь/,
  );
});

test('cloud writes scope their origin marker and native capture records command version', async () => {
  const source = await readFile(
    new URL('./src/CommonModules/AvtoPultИзмененияЗаказов/Module.bsl', import.meta.url),
    'utf8',
  );
  const orders = await readFile(
    new URL('./src/CommonModules/AvtoPultЗаказы/Module.bsl', import.meta.url),
    'utf8',
  );
  assert.match(
    orders,
    /AvtoPultИзмененияЗаказов\.ЗаписатьИзОблака\(Документ, Заказ\.version, Payload\)/,
  );
  assert.match(source, /Запись\.Origin = ИсточникЗаписи\.origin/);
  assert.match(source, /Запись\.CommandVersion = ИсточникЗаписи\.commandVersion/);
  const start = source.indexOf('Процедура ЗаписатьИзОблака(');
  const body = source.slice(start, source.indexOf('КонецПроцедуры', start));
  assert.match(body, /Не ТранзакцияАктивна\(\)/);
  assert.match(body, /РежимЗаписиДокумента\.Запись/);
  assert.equal(body.match(/ВосстановитьМаркер\(/g)?.length, 4);
  assert.match(body, /Исключение[\s\S]*ВосстановитьМаркер[\s\S]*ВызватьИсключение;/);
  assert.doesNotMatch(body, /ОбменДанными\.Загрузка|ЗафиксироватьТранзакцию|НачатьТранзакцию/);
});

test('cloud revision freezes validated command payload before write and restores both markers', async () => {
  const source = await readFile(
    new URL('./src/CommonModules/AvtoPultИзмененияЗаказов/Module.bsl', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('Процедура ЗаписатьИзОблака(');
  const body = source.slice(start, source.indexOf('КонецПроцедуры', start));
  assert.ok(
    body.indexOf('ПроверитьКоманду(Payload, ВерсияКоманды)') < body.indexOf('Документ.Записать('),
  );
  assert.ok(
    body.indexOf('PayloadJSON = AvtoPultКонтракт.JSON(Payload)') <
      body.indexOf('Документ.Записать('),
  );
  assert.match(body, /COMMAND_DOCUMENT_MISMATCH/);
  assert.equal(body.match(/ВосстановитьМаркер\(Свойства, "AvtoPultPayloadКоманды"/g)?.length, 2);
  assert.equal(body.match(/ВосстановитьМаркер\(Свойства, "AvtoPultВерсияКоманды"/g)?.length, 2);
  assert.match(source, /Запись\.AcceptedCloudPayloadJSON = ИсточникЗаписи\.payloadJSON/);
  assert.match(source, /Запись\.AcceptedCloudPayloadSHA256 = ИсточникЗаписи\.payloadSHA256/);
  assert.match(source, /ИсточникЗаписи\.workOrderId <> Связь\.WorkOrderId/);
  assert.match(source, /Свойство\(Заказ, "version"\) <> ВерсияКоманды/);
  assert.match(source, /ORPHAN_COMMAND_PAYLOAD/);
  assert.match(source, /COMMAND_PAYLOAD_REQUIRED/);
  assert.match(source, /ПроверитьКоманду\(Payload, ВерсияКоманды\)/);
  assert.match(source, /AvtoPultИнтеграция\.SHA256\(PayloadJSON\)/);
});

test('cloud write checks the persisted projection after all native write handlers', async () => {
  const source = await readFile(
    new URL('./src/CommonModules/AvtoPultИзмененияЗаказов/Module.bsl', import.meta.url),
    'utf8',
  );
  const orders = await readFile(
    new URL('./src/CommonModules/AvtoPultЗаказы/Module.bsl', import.meta.url),
    'utf8',
  );
  const body = orders.slice(0, orders.indexOf('КонецФункции'));
  const freeze = body.indexOf(
    'ОжидаемыйСнимокJSON = AvtoPultИзмененияЗаказов.СнимокЗаписиJSON(Документ)',
  );
  const write = body.indexOf('AvtoPultИзмененияЗаказов.ЗаписатьИзОблака(');
  const reread = body.indexOf('Документ = Документ.Ссылка.ПолучитьОбъект()');
  const verify = body.indexOf('ОжидаемыйСнимокJSON <> AvtoPultИзмененияЗаказов.СнимокЗаписиJSON');
  assert.ok(freeze >= 0 && freeze < write);
  assert.ok(write < reread && reread < verify && verify < body.indexOf('Связь.Записать()'));
  assert.match(body, /Возврат AvtoPultКонтракт\.Ошибка\("NATIVE_PROJECTION_CHANGED",[^\n]+409\)/);
  const projectionStart = source.indexOf('Функция СнимокЗаписиJSON(');
  const projection = source.slice(projectionStart, source.indexOf('КонецФункции', projectionStart));
  assert.match(projection, /Снимок = СнимокЗаказа\(Документ\)/);
  assert.deepEqual(
    [...projection.matchAll(/Удалить\("([^"]+)"\)/g)].map((m) => m[1]),
    ['externalId'],
  );
  assert.match(projection, /Возврат AvtoPultКонтракт\.JSON\(Снимок\)/);
  assert.doesNotMatch(body, /ЗафиксироватьТранзакцию|ОбменДанными\.Загрузка/);
});

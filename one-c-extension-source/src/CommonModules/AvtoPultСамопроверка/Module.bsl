// Execute on the test 1C server after syntax validation; this suite writes no documents.
Функция ПроверитьУстановку() Экспорт
	Проверок = 0;
	Для Каждого ИмяМодуля Из СтрРазделить(
		"AvtoPultИнтеграция,AvtoPultАдаптерКА2,AvtoPultДиагностикаКА2,AvtoPultЗаказы,AvtoPultИзмененияЗаказов,AvtoPultКонтракт,AvtoPultНативнаяПриемка,AvtoPultПроведение,AvtoPultРасчеты,AvtoPultСамопроверка,AvtoPultСчета", ",") Цикл
		Проверить(Метаданные.ОбщиеМодули.Найти(ИмяМодуля) <> Неопределено,
			"missing common module " + ИмяМодуля);
		Проверок = Проверок + 1;
	КонецЦикла;
	Проверить(Метаданные.HTTPСервисы.Найти("AvtoPult") <> Неопределено,
		"missing HTTP service AvtoPult");
	Проверок = Проверок + 1;

	Проверок = Проверок + ПроверитьРегистр("AvtoPultИдемпотентность",
		"Ключ,Операция,ХешЗапроса,КодОтвета,ТелоОтвета,ЗавершеноВ");
	Проверок = Проверок + ПроверитьРегистр("AvtoPultИсходящиеСобытия",
		"EventId,Вид,КлючЗаказа,Порядок,PayloadJSON,РезультатВерсияЗаказа,Содержимое,Состояние,LeaseToken,LeaseUntil,ЧислоПопыток,СозданоВ,ДоставленоВ");
	Проверок = Проверок + ПроверитьРегистр("AvtoPultЗаказы",
		"WorkOrderId,ЗаказКлиента,Версия,Хеш,Версия1С,StationId,ClientId,VehicleId,PayloadJSON,СчетВыставлен");
	Проверок = Проверок + ПроверитьРегистр("AvtoPultСтрокиЗаказов",
		"WorkOrderId,ItemId,КодСтроки,Номенклатура");
	Проверок = Проверок + ПроверитьРегистр("AvtoPultКлиенты",
		"ClientId,Партнер,Контрагент");
	Проверок = Проверок + ПроверитьРегистр("AvtoPultАвтомобили",
		"VehicleId,Автомобиль");
	Проверок = Проверок + ПроверитьРегистр("AvtoPultПрофилиСтанций",
		"StationId,ОбразецЗаказа,Проверен,БезНДСПодтверждено");
	Проверок = Проверок + ПроверитьРегистр("AvtoPultЗапросыСчетов",
		"Заказ,Попытка,Счет,СуммаТиын,ИдентификаторЗапроса,EventId,SHA256,Состояние");
	Проверок = Проверок + ПроверитьРегистр("AvtoPultГоловыИзмененийЗаказов",
		"WorkOrderId,Sequence,RevisionId");
	Проверок = Проверок + ПроверитьРегистр("AvtoPultИзмененияЗаказов",
		"WorkOrderId,Sequence,RevisionId,ParentRevisionId,ЗаказКлиента,BaseVersion,BasePayloadJSON,PayloadJSON,SHA256,СозданоВ,Состояние,Origin,CommandVersion,AcceptedCloudPayloadJSON,AcceptedCloudPayloadSHA256");
	Проверок = Проверок + ПроверитьРегистр("AvtoPultСостоянияРасчетов",
		"SourceKind,SourceId,AllocationKey,WorkOrderExternalId,Revision,Active,AmountTiyn,PrimaryEvent,InverseEvent");
	Проверок = Проверок + ПроверитьРегистр("AvtoPultИзмененияРасчетов",
		"EventId,PayloadJSON,WorkOrderExternalId,State,CreatedAt");

	Возврат Новый Структура("Проверок,Успех", Проверок, Истина);
КонецФункции

Функция ПроверитьРегистр(ИмяРегистра, ИменаПолей)
	ОбъектМетаданных = Метаданные.РегистрыСведений.Найти(ИмяРегистра);
	Проверить(ОбъектМетаданных <> Неопределено, "missing information register " + ИмяРегистра);
	Проверок = 1;
	Для Каждого ИмяПоля Из СтрРазделить(ИменаПолей, ",") Цикл
		ИмяПоля = СокрЛП(ИмяПоля);
		ПолеНайдено = ОбъектМетаданных.Измерения.Найти(ИмяПоля) <> Неопределено
			Или ОбъектМетаданных.Ресурсы.Найти(ИмяПоля) <> Неопределено
			Или ОбъектМетаданных.Реквизиты.Найти(ИмяПоля) <> Неопределено;
		Проверить(ПолеНайдено, "missing field " + ИмяРегистра + "." + ИмяПоля);
		Проверок = Проверок + 1;
	КонецЦикла;
	Возврат Проверок;
КонецФункции

Функция ПроверитьКонтракт() Экспорт
	Проверок = 0;
	Для Каждого Сумма Из СтрРазделить("0,1,9223372036854775807", ",") Цикл
		Проверить(AvtoPultКонтракт.ДеньгиДопустимы(Сумма), "canonical money");
		Проверок = Проверок + 1;
	КонецЦикла;
	Для Каждого Сумма Из СтрРазделить("-1,01,1.5,1e2, 1,9223372036854775808", ",") Цикл
		Проверить(Не AvtoPultКонтракт.ДеньгиДопустимы(Сумма), "invalid money");
		Проверок = Проверок + 1;
	КонецЦикла;
	Проверить(Не AvtoPultКонтракт.ДеньгиДопустимы(""), "empty money");
	Проверить(Не AvtoPultКонтракт.ДеньгиДопустимы(1), "numeric money");
	Проверить(AvtoPultКонтракт.СуммаСтроки(1, 0.499) = 0, "round below half");
	Проверить(AvtoPultКонтракт.СуммаСтроки(1, 0.5) = 1, "round half up");
	Проверить(AvtoPultКонтракт.СуммаСтроки(125, 1.25) = 156, "fraction quantity");
	Проверок = Проверок + 5;
	Чтение = Новый ЧтениеJSON;
	Чтение.УстановитьСтроку("{""leaseToken"":""token""}");
	Объект = ПрочитатьJSON(Чтение, Ложь);
	Чтение.Закрыть();
	Проверить(ТипЗнч(Объект) = Тип("Структура") И Объект.leaseToken = "token", "JSON object type");
	Проверить(AvtoPultИнтеграция.SHA256("") =
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "empty SHA256");
	Проверить(AvtoPultИнтеграция.SHA256("abc") =
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "SHA256 UTF8 no BOM");
	Проверок = Проверок + 3;
	Payload = ОбразецЗаказа();
	Проверить(AvtoPultКонтракт.ПроверитьЗаказ(Payload) = Неопределено, "valid order");
	Payload.workOrder.totalTiyn = "2";
	Проверить(AvtoPultКонтракт.ПроверитьЗаказ(Payload).Код = "ORDER_TOTAL_MISMATCH", "wrong total");
	Payload.workOrder.totalTiyn = "1";
	Payload.workOrder.items.Добавить(Payload.workOrder.items[0]);
	Проверить(AvtoPultКонтракт.ПроверитьЗаказ(Payload).Код = "DUPLICATE_ITEM_ID", "duplicate identity");
	Payload = ОбразецЗаказа();
	Payload.workOrder.Удалить("clientId");
	Проверить(AvtoPultКонтракт.ПроверитьЗаказ(Payload).Код = "REEXPORT_REQUIRED", "legacy identity");
	Payload = ОбразецЗаказа();
	Payload.workOrder.items[0].quantity = 0.0001;
	Проверить(AvtoPultКонтракт.ПроверитьЗаказ(Payload).Код = "ITEM_VALUE_INVALID", "quantity precision");
	Проверок = Проверок + 5;
	РучнаяЗапись = AvtoPultИзмененияЗаказов.ОпределитьИсточник(Новый Структура);
	Проверить(РучнаяЗапись.origin = "native" И РучнаяЗапись.commandVersion = 0, "native origin");
	Payload = ОбразецЗаказа();
	Payload.workOrder.version = 7;
	ПринятыйJSON = AvtoPultКонтракт.JSON(Payload);
	ОблачнаяЗапись = AvtoPultИзмененияЗаказов.ОпределитьИсточник(
		Новый Структура("AvtoPultВерсияКоманды,AvtoPultPayloadКоманды", 7, ПринятыйJSON));
	Проверить(ОблачнаяЗапись.origin = "cloud" И ОблачнаяЗапись.commandVersion = 7, "cloud origin");
	Payload.workOrder.version = 8;
	Проверить(ОблачнаяЗапись.payloadJSON = ПринятыйJSON, "immutable command JSON");
	Проверить(ОблачнаяЗапись.payloadSHA256 = AvtoPultИнтеграция.SHA256(ПринятыйJSON), "command JSON hash");
	Проверок = Проверок + 4;
	Проверок = Проверок + ПроверитьПорядокОчереди();
	Проверок = Проверок + ПроверитьИдентичностьСтрок();
	Возврат Новый Структура("Проверок,Успех", Проверок, Истина);
КонецФункции

Функция ПроверитьИдентичностьСтрок()
	CatalogId = "11111111-1111-4111-8111-111111111111";
	Связи = Новый Массив;
	Связи.Добавить(Новый Структура("lineCode,catalogId,itemId", 12, CatalogId, "item-1"));
	Результат = AvtoPultИзмененияЗаказов.ИдентичностьСтроки(12, CatalogId, Связи);
	Проверить(Результат.state = "matched" И Результат.itemId = "item-1", "stable row identity");
	Результат = AvtoPultИзмененияЗаказов.ИдентичностьСтроки(13, CatalogId, Связи);
	Проверить(Результат.state = "unmapped" И Результат.itemId = "", "new native row");
	Результат = AvtoPultИзмененияЗаказов.ИдентичностьСтроки(12,
		"22222222-2222-4222-8222-222222222222", Связи);
	Проверить(Результат.state = "conflict" И Результат.itemId = "", "changed row catalog");
	Связи.Добавить(Новый Структура("lineCode,catalogId,itemId", 12, CatalogId, "item-2"));
	Результат = AvtoPultИзмененияЗаказов.ИдентичностьСтроки(12, CatalogId, Связи);
	Проверить(Результат.state = "conflict" И Результат.itemId = "", "ambiguous row code");
	Связи.Удалить(1);
	Связи[0].itemId = "";
	Результат = AvtoPultИзмененияЗаказов.ИдентичностьСтроки(12, CatalogId, Связи);
	Проверить(Результат.state = "conflict" И Результат.itemId = "", "empty stable identity");
	Результат = AvtoPultИзмененияЗаказов.ИдентичностьСтроки(0, CatalogId, Связи);
	Проверить(Результат.state = "conflict" И Результат.itemId = "", "invalid row code");
	Возврат 6;
КонецФункции

Функция ПроверитьПорядокОчереди()
	Сейчас = Дата(2026, 10, 9, 12, 0, 0);
	Заказы = Новый Соответствие;
	Первая = Новый Структура("КлючЗаказа,Порядок,Состояние,LeaseUntil", "order-1", 1, "leased", Сейчас + 120);
	Следующая = Новый Структура("КлючЗаказа,Порядок,Состояние,LeaseUntil", "order-1", 2, "new", Дата(1, 1, 1));
	Другая = Новый Структура("КлючЗаказа,Порядок,Состояние,LeaseUntil", "order-2", 3, "new", Дата(1, 1, 1));
	Проверить(Не AvtoPultИнтеграция.ЭтоДоступнаяГолова(Первая, Заказы, Сейчас), "live head lease");
	Проверить(Не AvtoPultИнтеграция.ЭтоДоступнаяГолова(Следующая, Заказы, Сейчас), "successor blocked");
	Проверить(AvtoPultИнтеграция.ЭтоДоступнаяГолова(Другая, Заказы, Сейчас), "independent order");
	Заказы = Новый Соответствие;
	Проверить(AvtoPultИнтеграция.ЭтоДоступнаяГолова(Первая, Заказы, Сейчас + 121), "expired head retry");
	Проверить(Не AvtoPultИнтеграция.ЭтоДоступнаяГолова(Следующая, Заказы, Сейчас + 121), "retry blocks successor");
	Заказы = Новый Соответствие;
	Первая.Состояние = "reconciliation";
	Проверить(Не AvtoPultИнтеграция.ЭтоДоступнаяГолова(Первая, Заказы, Сейчас + 121), "conflicted head");
	Проверить(Не AvtoPultИнтеграция.ЭтоДоступнаяГолова(Следующая, Заказы, Сейчас + 121), "conflict blocks successor");
	// After durable ACK the query excludes the delivered predecessor, including after restart.
	Проверить(AvtoPultИнтеграция.ЭтоДоступнаяГолова(Следующая, Новый Соответствие, Сейчас), "next head after ACK");
	Возврат 8;
КонецФункции

Процедура Проверить(Условие, Имя)
	Если Не Условие Тогда
		ВызватьИсключение "AvtoPult self-test failed: " + Имя;
	КонецЕсли;
КонецПроцедуры

Функция ОбразецЗаказа()
	Позиция = Новый Структура("itemId,externalId,type,quantity,priceTiyn,mechanicShare,requiresApproval",
		"item-1", "11111111-1111-4111-8111-111111111111", "product", 0.5, "1", 0, Ложь);
	Строки = Новый Массив;
	Строки.Добавить(Позиция);
	Заказ = Новый Структура("workOrderId,clientId,vehicleId,stationExternalId,version,totalTiyn,status",
		"order-1", "client-1", "vehicle-1", "station-1", 1, "1", "created");
	Заказ.Вставить("items", Строки);
	Заказ.Вставить("client", Новый Структура("type", "person"));
	Заказ.Вставить("vehicle", Новый Структура);
	Возврат Новый Структура("contractVersion,workOrder", "1.0", Заказ);
КонецФункции

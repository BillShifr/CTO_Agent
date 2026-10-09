// Execute on the test 1C server after syntax validation; this suite writes no documents.
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
	ОблачнаяЗапись = AvtoPultИзмененияЗаказов.ОпределитьИсточник(
		Новый Структура("AvtoPultВерсияКоманды", 7));
	Проверить(ОблачнаяЗапись.origin = "cloud" И ОблачнаяЗапись.commandVersion = 7, "cloud origin");
	Проверок = Проверок + 2;
	Возврат Новый Структура("Проверок,Успех", Проверок, Истина);
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

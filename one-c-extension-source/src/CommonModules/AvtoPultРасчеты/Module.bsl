// FR-PAY-007/008: immutable settlement allocations. Subscribe to native object OnWrite events.
Процедура ПриЗаписиРасчетногоДокумента(Источник, Отказ) Экспорт
	Если Отказ Тогда Возврат; КонецЕсли;
	Если Не ТранзакцияАктивна() Тогда ВызватьИсключение "TRANSACTION_REQUIRED"; КонецЕсли;
	Профиль = ПрофильДокумента(Источник);
	Если Профиль = Неопределено Тогда Возврат; КонецЕсли;
	SourceId = GUIDСсылки(Источник.Ссылка);
	SourceKind = Профиль.SourceKind;
	ТекущиеКлючи = Новый Соответствие;
	Если Источник.Проведен И Не Источник.ПометкаУдаления
		И ОперацияСовпадает(Источник.ХозяйственнаяОперация, Профиль.Operation) Тогда
		Для Каждого Строка Из Источник.РасшифровкаПлатежа Цикл
			Заказ = ЗаказСтроки(Строка);
			Если Заказ = Неопределено Тогда Продолжить; КонецЕсли;
			WorkOrderExternalId = GUIDСсылки(Заказ);
			Если Не ЗаказСвязан(Заказ) Тогда Продолжить; КонецЕсли;
			AllocationKey = Строка(Строка.НомерСтроки);
			Если ТекущиеКлючи.Получить(AllocationKey) <> Неопределено Тогда
				ВызватьИсключение "DUPLICATE_SETTLEMENT_ALLOCATION";
			КонецЕсли;
			ТекущиеКлючи.Вставить(AllocationKey, Истина);
			AmountTiyn = Тиыны(Строка.Сумма);
			ПрименитьСостояние(SourceKind, SourceId, AllocationKey, WorkOrderExternalId,
				Истина, AmountTiyn, Профиль.PrimaryEvent, Профиль.InverseEvent);
		КонецЦикла;
	КонецЕсли;
	ДеактивироватьОтсутствующие(SourceKind, SourceId, ТекущиеКлючи);
КонецПроцедуры

// Called under the global outbox lock before claim.
Процедура ПоставитьОжидающиеВОчердь() Экспорт
	Если Не ТранзакцияАктивна() Тогда ВызватьИсключение "TRANSACTION_REQUIRED"; КонецЕсли;
	Запрос = Новый Запрос("ВЫБРАТЬ EventId, PayloadJSON
		|ИЗ РегистрСведений.AvtoPultИзмененияРасчетов
		|ГДЕ State = &Pending УПОРЯДОЧИТЬ ПО CreatedAt, EventId");
	Запрос.УстановитьПараметр("Pending", "pending");
	Обработано = 0;
	Для Каждого Строка Из Запрос.Выполнить().Выгрузить() Цикл
		Payload = ПрочитатьСтруктуруJSON(Строка.PayloadJSON);
		AvtoPultИнтеграция.ПоставитьСобытиеВОчердь(Строка.EventId, Payload);
		ИзменитьСостояниеСобытия(Строка.EventId, "queued");
		Обработано = Обработано + 1;
		Если Обработано >= 50 Тогда Прервать; КонецЕсли;
	КонецЦикла;
КонецПроцедуры

Процедура ПодтвердитьДоставку(EventId) Экспорт
	Если Не ТранзакцияАктивна() Тогда ВызватьИсключение "TRANSACTION_REQUIRED"; КонецЕсли;
	Запись = РегистрыСведений.AvtoPultИзмененияРасчетов.СоздатьМенеджерЗаписи();
	Запись.EventId = EventId;
	Запись.Прочитать();
	Если Не Запись.Выбран() Тогда Возврат; КонецЕсли;
	Если Запись.State <> "queued" Тогда ВызватьИсключение "SETTLEMENT_EVENT_NOT_QUEUED"; КонецЕсли;
	Запись.State = "delivered";
	Запись.Записать();
КонецПроцедуры

Процедура ПрименитьСостояние(SourceKind, SourceId, AllocationKey, WorkOrderExternalId,
	Активно, AmountTiyn, PrimaryEvent, InverseEvent)
	ЗаблокироватьСостояние(SourceKind, SourceId, AllocationKey);
	Состояние = ПолучитьСостояние(SourceKind, SourceId, AllocationKey);
	Изменилось = Состояние.Active И (Не Активно Или Состояние.AmountTiyn <> AmountTiyn
		Или Состояние.WorkOrderExternalId <> WorkOrderExternalId
		Или Состояние.PrimaryEvent <> PrimaryEvent);
	Если Изменилось Тогда
		Revision = Состояние.Revision + 1;
		ЗаписатьСобытие(InverseEvent, SourceKind, SourceId, AllocationKey, Revision,
			Состояние.WorkOrderExternalId, Состояние.AmountTiyn);
		Состояние.Active = Ложь;
		Состояние.Revision = Revision;
	КонецЕсли;
	Если Активно И Не Состояние.Active Тогда
		Revision = Состояние.Revision + 1;
		ЗаписатьСобытие(PrimaryEvent, SourceKind, SourceId, AllocationKey, Revision,
			WorkOrderExternalId, AmountTiyn);
		Состояние.Active = Истина;
		Состояние.Revision = Revision;
		Состояние.WorkOrderExternalId = WorkOrderExternalId;
		Состояние.AmountTiyn = AmountTiyn;
		Состояние.PrimaryEvent = PrimaryEvent;
		Состояние.InverseEvent = InverseEvent;
	КонецЕсли;
	ЗаписатьСостояние(SourceKind, SourceId, AllocationKey, Состояние);
КонецПроцедуры

Процедура ДеактивироватьОтсутствующие(SourceKind, SourceId, ТекущиеКлючи)
	Запрос = Новый Запрос("ВЫБРАТЬ AllocationKey, WorkOrderExternalId, Revision, Active,
		| AmountTiyn, PrimaryEvent, InverseEvent
		|ИЗ РегистрСведений.AvtoPultСостоянияРасчетов
		|ГДЕ SourceKind = &SourceKind И SourceId = &SourceId И Active = ИСТИНА");
	Запрос.УстановитьПараметр("SourceKind", SourceKind);
	Запрос.УстановитьПараметр("SourceId", SourceId);
	Для Каждого Строка Из Запрос.Выполнить().Выгрузить() Цикл
		Если ТекущиеКлючи.Получить(Строка.AllocationKey) <> Неопределено Тогда Продолжить; КонецЕсли;
		ПрименитьСостояние(SourceKind, SourceId, Строка.AllocationKey,
			Строка.WorkOrderExternalId, Ложь, Строка.AmountTiyn, Строка.PrimaryEvent, Строка.InverseEvent);
	КонецЦикла;
КонецПроцедуры

Процедура ЗаписатьСобытие(EventName, SourceKind, SourceId, AllocationKey, Revision,
	WorkOrderExternalId, AmountTiyn)
	Если Revision > 999999999999999 Тогда ВызватьИсключение "SETTLEMENT_REVISION_OVERFLOW"; КонецЕсли;
	ExternalId = НРег(SourceKind) + ":" + SourceId + ":" + AllocationKey + ":" + Строка(Revision);
	EventId = "settlement-" + AvtoPultИнтеграция.SHA256(EventName + ":" + ExternalId);
	Payload = Новый Структура("event,eventId,workOrderExternalId,occurredAt,amountTiyn",
		EventName, EventId, WorkOrderExternalId,
		Формат(ТекущаяУниверсальнаяДата(), "ДФ=yyyy-MM-ddTHH:mm:ss") + "Z", AmountTiyn);
	Если СтрЗаканчиваетсяНа(EventName, ".payment") Тогда
		Payload.Вставить("paymentExternalId", ExternalId);
	Иначе
		Payload.Вставить("refundExternalId", ExternalId);
	КонецЕсли;
	Запись = РегистрыСведений.AvtoPultИзмененияРасчетов.СоздатьМенеджерЗаписи();
	Запись.EventId = EventId;
	Запись.Прочитать();
	Если Запись.Выбран() Тогда ВызватьИсключение "SETTLEMENT_EVENT_ALREADY_EXISTS"; КонецЕсли;
	Запись.PayloadJSON = AvtoPultКонтракт.JSON(Payload);
	Запись.WorkOrderExternalId = WorkOrderExternalId;
	Запись.State = "pending";
	Запись.CreatedAt = ТекущаяУниверсальнаяДата();
	Запись.Записать();
КонецПроцедуры

Функция ПолучитьСостояние(SourceKind, SourceId, AllocationKey)
	Запись = РегистрыСведений.AvtoPultСостоянияРасчетов.СоздатьМенеджерЗаписи();
	Запись.SourceKind = SourceKind;
	Запись.SourceId = SourceId;
	Запись.AllocationKey = AllocationKey;
	Запись.Прочитать();
	Если Не Запись.Выбран() Тогда
		Возврат Новый Структура("WorkOrderExternalId,Revision,Active,AmountTiyn,PrimaryEvent,InverseEvent",
			"", 0, Ложь, "0", "", "");
	КонецЕсли;
	Возврат Новый Структура("WorkOrderExternalId,Revision,Active,AmountTiyn,PrimaryEvent,InverseEvent",
		Запись.WorkOrderExternalId, Запись.Revision, Запись.Active, Запись.AmountTiyn,
		Запись.PrimaryEvent, Запись.InverseEvent);
КонецФункции

Процедура ЗаписатьСостояние(SourceKind, SourceId, AllocationKey, Состояние)
	Запись = РегистрыСведений.AvtoPultСостоянияРасчетов.СоздатьМенеджерЗаписи();
	Запись.SourceKind = SourceKind;
	Запись.SourceId = SourceId;
	Запись.AllocationKey = AllocationKey;
	Запись.WorkOrderExternalId = Состояние.WorkOrderExternalId;
	Запись.Revision = Состояние.Revision;
	Запись.Active = Состояние.Active;
	Запись.AmountTiyn = Состояние.AmountTiyn;
	Запись.PrimaryEvent = Состояние.PrimaryEvent;
	Запись.InverseEvent = Состояние.InverseEvent;
	Запись.Записать();
КонецПроцедуры

Функция ПрофильДокумента(Источник)
	ТипИсточника = ТипЗнч(Источник);
	Если ТипИсточника = Тип("ДокументОбъект.ПриходныйКассовыйОрдер") Тогда
		Возврат Новый Структура("SourceKind,Operation,PrimaryEvent,InverseEvent",
			"cash-in", "ПоступлениеОплатыОтКлиента", "cash.payment", "cash.refund");
	ИначеЕсли ТипИсточника = Тип("ДокументОбъект.ПоступлениеБезналичныхДенежныхСредств")
		Или ТипИсточника = Тип("ДокументОбъект.ОперацияПоПлатежнойКарте") Тогда
		Возврат Новый Структура("SourceKind,Operation,PrimaryEvent,InverseEvent",
			"invoice-in", "ПоступлениеОплатыОтКлиента", "invoice.payment", "invoice.refund");
	ИначеЕсли ТипИсточника = Тип("ДокументОбъект.РасходныйКассовыйОрдер") Тогда
		Возврат Новый Структура("SourceKind,Operation,PrimaryEvent,InverseEvent",
			"cash-out", "ВозвратОплатыКлиенту", "cash.refund", "cash.payment");
	ИначеЕсли ТипИсточника = Тип("ДокументОбъект.СписаниеБезналичныхДенежныхСредств") Тогда
		Возврат Новый Структура("SourceKind,Operation,PrimaryEvent,InverseEvent",
			"invoice-out", "ВозвратОплатыКлиенту", "invoice.refund", "invoice.payment");
	КонецЕсли;
	Возврат Неопределено;
КонецФункции

Функция ОперацияСовпадает(Операция, ОжидаемоеИмя)
	// String(enum) may be either the internal name or the localized presentation.
	ФактическоеИмя = НРег(СтрЗаменить(СокрЛП(Строка(Операция)), " ", ""));
	Возврат ФактическоеИмя = НРег(ОжидаемоеИмя);
КонецФункции

Функция ЗаказСтроки(Строка)
	Если ТипЗнч(Строка.ОснованиеПлатежа) = Тип("ДокументСсылка.ЗаказКлиента") Тогда
		Возврат Строка.ОснованиеПлатежа;
	КонецЕсли;
	Если ТипЗнч(Строка.Заказ) = Тип("ДокументСсылка.ЗаказКлиента") Тогда Возврат Строка.Заказ; КонецЕсли;
	Возврат Неопределено;
КонецФункции

Функция ЗаказСвязан(Заказ)
	Запрос = Новый Запрос("ВЫБРАТЬ ПЕРВЫЕ 2 WorkOrderId ИЗ РегистрСведений.AvtoPultЗаказы ГДЕ ЗаказКлиента = &Заказ");
	Запрос.УстановитьПараметр("Заказ", Заказ);
	Результат = Запрос.Выполнить().Выгрузить();
	Если Результат.Количество() > 1 Тогда ВызватьИсключение "AMBIGUOUS_ORDER_BINDING"; КонецЕсли;
	Возврат Результат.Количество() = 1;
КонецФункции

Функция Тиыны(Сумма)
	Если ТипЗнч(Сумма) <> Тип("Число") Или Сумма <= 0 Или Цел(Сумма * 100) <> Сумма * 100 Тогда
		ВызватьИсключение "SETTLEMENT_AMOUNT_INVALID";
	КонецЕсли;
	Возврат Формат(Сумма * 100, "ЧГ=0;ЧДЦ=0");
КонецФункции

Процедура ЗаблокироватьСостояние(SourceKind, SourceId, AllocationKey)
	Блокировка = Новый БлокировкаДанных;
	Элемент = Блокировка.Добавить("РегистрСведений.AvtoPultСостоянияРасчетов");
	Элемент.Режим = РежимБлокировкиДанных.Исключительный;
	Элемент.УстановитьЗначение("SourceKind", SourceKind);
	Элемент.УстановитьЗначение("SourceId", SourceId);
	Элемент.УстановитьЗначение("AllocationKey", AllocationKey);
	Блокировка.Заблокировать();
КонецПроцедуры

Процедура ИзменитьСостояниеСобытия(EventId, State)
	Запись = РегистрыСведений.AvtoPultИзмененияРасчетов.СоздатьМенеджерЗаписи();
	Запись.EventId = EventId;
	Запись.Прочитать();
	Если Не Запись.Выбран() Тогда ВызватьИсключение "SETTLEMENT_EVENT_NOT_FOUND"; КонецЕсли;
	Запись.State = State;
	Запись.Записать();
КонецПроцедуры

Функция ПрочитатьСтруктуруJSON(JSON)
	Чтение = Новый ЧтениеJSON;
	Чтение.УстановитьСтроку(JSON);
	Результат = ПрочитатьJSON(Чтение, Ложь);
	Чтение.Закрыть();
	Если ТипЗнч(Результат) <> Тип("Структура") Тогда ВызватьИсключение "SETTLEMENT_EVENT_INVALID"; КонецЕсли;
	Возврат Результат;
КонецФункции

Функция GUIDСсылки(Ссылка)
	Возврат Строка(Ссылка.УникальныйИдентификатор());
КонецФункции

# AvtoPult 1C Integration Agent

Windows-служба рядом с 1С. Она открывает только исходящие HTTPS-соединения к AvtoPult Cloud,
забирает команды, обращается к локальным HTTP/OData endpoint 1С и возвращает результат. Публичный
IP, домен, входящий port-forward и Radmin VPN для production-контура не требуются.

## Обязательные поля конфигурации

```text
AVTOPULT_AGENT_ID=<выдаётся облаком при enrollment>
AVTOPULT_API_URL=https://api.example.kz/api/v1/
AVTOPULT_AGENT_SECRET=<однократно выдаётся облаком при enrollment>
ONE_C_WRITE_URL=http://127.0.0.1/infobase/hs/avtopult/v1/
ONE_C_USERNAME=avtopult-writer
ONE_C_PASSWORD=<секрет записи 1С>
ONE_C_ODATA_URL=http://127.0.0.1/infobase/odata/standard.odata/
ONE_C_ODATA_USERNAME=avtopult-reader
ONE_C_ODATA_PASSWORD=<секрет чтения 1С>
ONE_C_ALLOW_HTTP=1
ONE_C_ALLOW_WRITES=0
AVTOPULT_AGENT_STATE_DIR=C:\ProgramData\AvtoPult\OneCAgent
AVTOPULT_AGENT_MAX_STATE_BYTES=2000000000
AVTOPULT_AGENT_MIN_FREE_BYTES=1000000000
```

`ONE_C_ALLOW_HTTP=1` допустим только для loopback/LAN-сегмента заказчика. Связь с облаком всегда
HTTPS. Windows-служба читает `agent-config.json` из защищённого каталога состояния: доступ имеют
только SYSTEM и Administrators. Не сохраняйте секреты в системных переменных Windows или Git.
Если использовали старый установщик, смените три секрета: удаление переменных не отзывает их.

## Kaspi Smart POS (опционально)

Smart POS находится в той же локальной сети. Для него нужны локальное DNS-имя вида
`*.kaspipos.kz`, HTTPS на порту `8080`, имя зарегистрированной кассы, access token, refresh token
и callback secret. Публичный IP СТО не требуется. Добавьте к команде конфигуратора:

```powershell
  -KaspiSmartPosUrl 'https://terminal-01.kaspipos.kz:8080/' `
  -KaspiSmartPosName 'AvtoPult-station-1'
```

Скрипт запросит секреты терминала интерактивно. Агент сохраняет обновлённую пару токенов в
защищённом каталоге состояния и не считает неподтверждённый статус терминала оплатой.

## Сборка release-артефакта

```bash
npm install --global npm@11.6.1
npm ci
npm run bundle
```

Готовый автономный JavaScript bundle, установщик, деинсталлятор и `SHA256SUMS` появляются в
`.artifacts/one-c-agent`. Windows job CI дополнительно публикует единый архив
`AvtoPult-OneCAgent-windows-x64.zip`, его внешний SHA-256 и уже проверенный `WinSW-x64.exe`.
Перед распаковкой сверьте внешний hash архива, после распаковки — внутренний `SHA256SUMS`.
На Windows дополнительно нужен только Node.js 22 LTS. Обычный `sc.exe create node.exe`
не используется: Node.js сам по себе не реализует протокол Windows Service Control Manager.

Скачайте `WinSW-x64.exe` только из [официального release WinSW
2.12.0](https://github.com/winsw/winsw/releases/tag/v2.12.0). Установщик по умолчанию принимает
SHA-256 `05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da` и прекращает работу при
несовпадении.

## Установка Windows-службы

Сначала владелец или администратор AvtoPult выпускает в кабинете одноразовый код подключения.
Код короткоживущий и после первого успешного обмена повторно не принимается. Откройте PowerShell
от имени администратора и создайте файл конфигурации. Скрипт скрыто запросит код и пароли 1С,
обменяет код по HTTPS на отдельные `agentId` и `agentSecret`, проверит запрет кеширования ответа и
атомарно запишет конфигурацию с ACL только для SYSTEM и Administrators:

```powershell
powershell -ExecutionPolicy Bypass -File C:\AvtoPult\OneCAgent\configure-environment.ps1 `
  -ApiUrl 'https://api.example.kz/api/v1/' `
  -OneCWriteUrl 'http://127.0.0.1/infobase/hs/avtopult/v1/' `
  -OneCUsername 'avtopult-writer' `
  -OneCODataUrl 'http://127.0.0.1/infobase/odata/standard.odata/' `
  -OneCODataUsername 'avtopult-reader' `
  -AllowLocalHttp
```

`-UseExistingAgentCredential -AgentId ...` оставлен только для переноса уже зарегистрированного
агента. В этом режиме существующий секрет вводится скрыто. Для нового production-подключения
используйте одноразовый enrollment-код.

После этого установите службу:

Без `-AllowWrites` запись заблокирована. После приёмки на копии администратор может установить
`ONE_C_ALLOW_WRITES` в `"1"` в защищённом `agent-config.json` и перезапустить службу.
Задания, уже отклонённые с `WRITES_DISABLED`, сами не возобновятся: повторно отправляйте их
через AvtoPult только после проверки текущего состояния 1С.

```powershell
powershell -ExecutionPolicy Bypass -File C:\AvtoPult\OneCAgent\install-service.ps1 `
  -NodeExe 'C:\Program Files\nodejs\node.exe' `
  -AgentDirectory 'C:\AvtoPult\OneCAgent'
```

Установщик проверяет WinSW из release-пакета и наличие полей конфигурации без вывода их значений,
ограничивает ACL каталогов состояния и исполняемого кода, устанавливает автозапуск с задержкой,
три перезапуска и ротацию логов. Установка считается успешной только после свежего heartbeat,
который облако приняло от запущенной службы; receipt сохраняется атомарно в защищённом каталоге.
При ошибке первой установки созданная служба удаляется. Повторный
запуск установщика для существующей службы запрещён: обновление выполняется только через
`update-service.ps1`, который автоматически возвращает предыдущую версию при сбое. Непереданный ответ атомарно сохраняется на диске и
отправляется после восстановления сети до получения новой команды. Cloud lease возвращает
зависшую команду в очередь. Защита от повторного бизнес-эффекта требует реализации атомарной
идемпотентности серверным модулем 1С; один заголовок `Idempotency-Key` этого не обеспечивает.
При конфликте lease результат сохраняется для повторной выдачи команды/разбора и не блокирует
остальную очередь. Каталог установки и Node.js должны быть недоступны для записи обычным
пользователям. Транзакции обновления и отката проверяются в Windows CI на тестовой службе;
фактическая установка на сервере заказчика остаётся обязательной частью финальной приёмки.

По умолчанию агент перестаёт забирать новые команды, если каталог состояния достиг 2 ГБ или на
диске осталось меньше 1 ГБ. Уже сохранённые результаты продолжают отправляться, а состояние
очередей и диска передаётся в heartbeat. Пороговые значения можно изменить указанными выше
полями конфигурации; уменьшать их ниже максимального ожидаемого OData-ответа нельзя.

Большие OData-ответы передаются частями с SHA-256 и сохраняются до подтверждения облаком.
Исходящие события и PDF-счета удаляются из локального outbox 1С только после подтверждения с тем
же `eventId`. В release входят `one-c-extension-source`, `one-c-write-api.md` и инструкция
`one-c-extension-source/MAXIM-HANDOFF.md`; специалист 1С адаптирует каркас к метаданным целевой
конфигурации, собирает `.cfe` и выполняет матрицу приёмки.

## Диагностика, обновление и ротация

```powershell
# Проверка ACL, службы, диска и авторизации без получения команд и создания операций
.\diagnose-agent.ps1 -NodeExe 'C:\Program Files\nodejs\node.exe' `
  -AgentDirectory 'C:\AvtoPult\OneCAgent'

# Обновление из проверенного release с автоматическим возвратом старой версии при сбое
.\update-service.ps1 -NodeExe 'C:\Program Files\nodejs\node.exe' `
  -CurrentDirectory 'C:\AvtoPult\OneCAgent' -ReleaseDirectory 'C:\Install\OneCAgent-new'

# Ротация agent credential по новому одноразовому коду и локального пароля 1С
.\rotate-secrets.ps1 -NodeExe 'C:\Program Files\nodejs\node.exe' `
  -AgentDirectory 'C:\AvtoPult\OneCAgent' -AgentSecret -OneCWritePassword
```

Перед ротацией agent credential выпустите новый одноразовый код в кабинете. Скрипт получает новую
пару `agentId`/`agentSecret`, проверяет новые доступы до замены файла и возвращает прежнюю
конфигурацию, если служба не восстановилась. Постоянный secret не копируется через буфер обмена.

Удаление службы сохраняет disk spool для расследования и безопасного повторного запуска:

```powershell
powershell -ExecutionPolicy Bypass -File C:\AvtoPult\OneCAgent\uninstall-service.ps1 `
  -AgentDirectory 'C:\AvtoPult\OneCAgent'
```

## Настройка подключения в AvtoPult

```json
{
  "mode": "live",
  "agent": {
    "enabled": true,
    "waitMs": 15000,
    "productRetailPriceTypeId": "<GUID>",
    "serviceRetailPriceTypeId": "<GUID>",
    "purchasePriceTypeId": "<GUID>",
    "defaultServiceNormHours": 0.5
  },
  "callback": { "secretRef": "env:ONE_C_CALLBACK_SECRET" }
}
```

Agent credential создаётся enrollment API и используется только для agent endpoints. Он не должен
совпадать с callback/write secret подключения. В production используются разные пользователи 1С:
read-only для OData и writer только для `/hs/avtopult/v1/`.

## Контроль перед включением записи

- Проверить на копии создание заказа/счёта, повтор одной команды и потерянный ответ 1С.
- Проверить отключение интернета, перезапуск службы/Windows и доставку сохранённого результата.
- Убедиться, что OData-пользователь не может записывать данные, а обычный Windows-пользователь — читать конфигурацию или менять код службы.
- Настроить оповещение об отсутствии heartbeat и свободном месте; не очищать очередь при сбоях.
- Проверить восстановление резервной копии и согласовать права/доступные объекты с 1С-специалистом.

Аварийная остановка (PowerShell администратора): `Stop-Service AvtoPultOneCAgent`.
Остановка не откатывает уже выполненное задание. При подозрении на утечку дополнительно отозвать
секрет облака и пароли 1С; один перезапуск не отзывает доступ.

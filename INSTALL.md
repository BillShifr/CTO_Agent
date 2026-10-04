# AvtoPult 1C Integration Agent

Windows-служба рядом с 1С. Она открывает только исходящие HTTPS-соединения к AvtoPult Cloud,
забирает команды, обращается к локальным HTTP/OData endpoint 1С и возвращает результат. Публичный
IP, домен, входящий port-forward и Radmin VPN для production-контура не требуются.

## Обязательные поля конфигурации

```text
AVTOPULT_AGENT_ID=station-01
AVTOPULT_API_URL=https://api.example.kz/api/v1/
AVTOPULT_AGENT_SECRET=<отдельный случайный секрет минимум 32 символа>
ONE_C_WRITE_URL=http://127.0.0.1/infobase/hs/avtopult/v1/
ONE_C_USERNAME=avtopult-writer
ONE_C_PASSWORD=<секрет записи 1С>
ONE_C_ODATA_URL=http://127.0.0.1/infobase/odata/standard.odata/
ONE_C_ODATA_USERNAME=avtopult-reader
ONE_C_ODATA_PASSWORD=<секрет чтения 1С>
ONE_C_ALLOW_HTTP=1
ONE_C_ALLOW_WRITES=0
AVTOPULT_AGENT_STATE_DIR=C:\ProgramData\AvtoPult\OneCAgent
```

`ONE_C_ALLOW_HTTP=1` допустим только для loopback/LAN-сегмента заказчика. Связь с облаком всегда
HTTPS. Windows-служба читает `agent-config.json` из защищённого каталога состояния: доступ имеют
только SYSTEM и Administrators. Не сохраняйте секреты в системных переменных Windows или Git.
Если использовали старый установщик, смените три секрета: удаление переменных не отзывает их.

## Сборка release-артефакта

```bash
npm install --global npm@11.6.1
npm ci
npm run bundle
```

Готовый автономный JavaScript bundle, установщик, деинсталлятор и `SHA256SUMS` появляются в
`.artifacts/one-c-agent`. В CI эта папка публикуется отдельным artifact. На Windows нужен только
Node.js 22 LTS и проверенный service-wrapper WinSW 2.12.0 x64. Обычный `sc.exe create node.exe`
не используется: Node.js сам по себе не реализует протокол Windows Service Control Manager.

Скачайте `WinSW-x64.exe` только из [официального release WinSW
2.12.0](https://github.com/winsw/winsw/releases/tag/v2.12.0). Установщик по умолчанию принимает
SHA-256 `05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da` и прекращает работу при
несовпадении.

## Установка Windows-службы

Сначала откройте PowerShell от имени администратора и создайте файл конфигурации. Скрипт
запрашивает три секрета интерактивно и не передаёт их в аргументах командной строки:

```powershell
powershell -ExecutionPolicy Bypass -File C:\AvtoPult\OneCAgent\configure-environment.ps1 `
  -AgentId 'customer-production' `
  -ApiUrl 'https://api.example.kz/api/v1/' `
  -OneCWriteUrl 'http://127.0.0.1/infobase/hs/avtopult/v1/' `
  -OneCUsername 'avtopult-writer' `
  -OneCODataUrl 'http://127.0.0.1/infobase/odata/standard.odata/' `
  -OneCODataUsername 'avtopult-reader' `
  -AllowLocalHttp
```

После этого установите службу:

Без `-AllowWrites` запись заблокирована. После приёмки на копии администратор может установить
`ONE_C_ALLOW_WRITES` в `"1"` в защищённом `agent-config.json` и перезапустить службу.
Задания, уже отклонённые с `WRITES_DISABLED`, сами не возобновятся: повторно отправляйте их
через AvtoPult только после проверки текущего состояния 1С.

```powershell
powershell -ExecutionPolicy Bypass -File C:\AvtoPult\OneCAgent\install-service.ps1 `
  -NodeExe 'C:\Program Files\nodejs\node.exe' `
  -AgentDirectory 'C:\AvtoPult\OneCAgent' `
  -WinSWExe 'C:\Install\WinSW-x64.exe'
```

Установщик проверяет наличие полей конфигурации без вывода их значений, ограничивает ACL каталога
состояния, устанавливает автозапуск с задержкой, три перезапуска и ротацию логов. Повторный запуск
обновляет существующую службу. Непереданный ответ атомарно сохраняется на диске и
отправляется после восстановления сети до получения новой команды. Cloud lease возвращает
зависшую команду в очередь. Защита от повторного бизнес-эффекта требует реализации атомарной
идемпотентности серверным модулем 1С; один заголовок `Idempotency-Key` этого не обеспечивает.
При конфликте lease результат сохраняется для повторной выдачи команды/разбора и не блокирует
остальную очередь. Каталог установки и Node.js должны быть недоступны для записи обычным
пользователям. Установка/перезагрузка Windows пока требуют отдельного acceptance-прогона.

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
  "callback": { "secretRef": "env:ONE_C_AGENT_SECRET" }
}
```

`IntegrationConnection.secretRef` ссылается на тот же отдельный agent secret. В production
используются разные пользователи 1С: read-only для OData и writer только для `/hs/avtopult/v1/`.

## Контроль перед включением записи

- Проверить на копии создание заказа/счёта, повтор одной команды и потерянный ответ 1С.
- Проверить отключение интернета, перезапуск службы/Windows и доставку сохранённого результата.
- Убедиться, что OData-пользователь не может записывать данные, а обычный Windows-пользователь — читать конфигурацию или менять код службы.
- Настроить оповещение об отсутствии heartbeat и свободном месте; не очищать очередь при сбоях.
- Проверить восстановление резервной копии и согласовать права/доступные объекты с 1С-специалистом.

Аварийная остановка (PowerShell администратора): `Stop-Service AvtoPultOneCAgent`.
Остановка не откатывает уже выполненное задание. При подозрении на утечку дополнительно отозвать
секрет облака и пароли 1С; один перезапуск не отзывает доступ.

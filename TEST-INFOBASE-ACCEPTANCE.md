# Проверка интеграции на тестовой базе 1С

Эта последовательность работает только с копией базы. Боевую базу не выбирать и запись агента
не включать до завершения всех проверок.

## 1. Зафиксировать тестовый контур

В окне запуска 1С выбрать базу «МИР КОЛОДОК КОПИЯ ДЛЯ РАЗРАБОТКИ И ТЕСТОВ». В нижней части окна
записать значения `Srvr` и `Ref`. Они понадобятся в формате `сервер\имя_базы`.

В PowerShell проверить установленную платформу:

```powershell
$platform = Get-ChildItem 'C:\Program Files\1cv8' -Filter 1cv8.exe -Recurse |
    Sort-Object { [version]$_.VersionInfo.ProductVersion } -Descending |
    Select-Object -First 1 -ExpandProperty FullName
Get-Item $platform | Select-Object FullName, @{n='Version';e={$_.VersionInfo.ProductVersion}}
```

Ожидаемая версия указана в `one-c-extension-source\extension-project-manifest.json`. Если версия
не совпадает, остановиться: пакет нужно собирать платформой той версии, для которой он проверен.

## 2. Создать каркас расширения

В Конфигураторе тестовой базы:

1. Открыть «Конфигурация → Расширения конфигурации».
2. Создать расширение `AvtoPult`.
3. Создать объекты из `one-c-extension-source\extension-project-manifest.json`.
4. Поля регистров создать по файлам `*-METADATA.md`.
5. HTTP-сервис, роли и подписки создать по `one-c-extension-source\P-13-ONE-C-PRODUCTION.md`.
6. Выгрузить расширение в файлы в `C:\AvtoPult\extension-project`.

Каркас должен содержать `Configuration.xml`. UUID объектов задаёт Конфигуратор; вручную их не
придумывать и не копировать из другой конфигурации.

## 3. Собрать расширение

Открыть PowerShell в корне пакета агента и выполнить:

```powershell
$infoBase = Read-Host 'Введите Srvr\Ref тестовой базы'
$credential = Get-Credential -Message 'Администратор ТЕСТОВОЙ базы 1С'
$env:AVTOPULT_1C_USER = $credential.UserName
$env:AVTOPULT_1C_PASSWORD = $credential.GetNetworkCredential().Password
try {
    & '.\one-c-extension-source\tools\Build-Extension.ps1' `
        -PlatformExe $platform `
        -InfoBase $infoBase `
        -ExportedProject 'C:\AvtoPult\extension-project' `
        -OutputCfe 'C:\AvtoPult\artifacts\AvtoPult.cfe' `
        -EnvironmentAcknowledgement I-CONFIRM-NON-PRODUCTION-BUILD-INFOBASE
}
finally {
    Remove-Item Env:AVTOPULT_1C_USER, Env:AVTOPULT_1C_PASSWORD -ErrorAction SilentlyContinue
}
```

Результат: `C:\AvtoPult\artifacts\AvtoPult.cfe`, контрольная сумма и логи пяти проверок.

## 4. Установить в тестовую базу

```powershell
$credential = Get-Credential -Message 'Администратор ТЕСТОВОЙ базы 1С'
$env:AVTOPULT_1C_USER = $credential.UserName
$env:AVTOPULT_1C_PASSWORD = $credential.GetNetworkCredential().Password
try {
    & '.\one-c-extension-source\tools\Install-TestExtension.ps1' `
        -PlatformExe $platform `
        -InfoBase $infoBase `
        -Cfe 'C:\AvtoPult\artifacts\AvtoPult.cfe' `
        -EnvironmentAcknowledgement I-CONFIRM-TEST-INFOBASE
}
finally {
    Remove-Item Env:AVTOPULT_1C_USER, Env:AVTOPULT_1C_PASSWORD -ErrorAction SilentlyContinue
}
```

Установка должна завершить четыре проверки без ошибок. При ошибке открыть соответствующий файл
в `C:\AvtoPult\artifacts\install-logs`; проверки не отключать.

## 5. Проверить HTTP-сервис

Опубликовать тестовую базу с HTTP-сервисом расширения и OData. Затем выполнить:

```powershell
$base = (Read-Host 'URL публикации ТЕСТОВОЙ базы, без завершающего /').TrimEnd('/')
$writeUser = Read-Host 'Пользователь HTTP-сервиса 1С'
curl.exe --fail --show-error --user $writeUser `
    --header 'X-AvtoPult-Contract-Version: 1.0' `
    --url "$base/hs/avtopult/v1/diagnostics"
```

Ожидается HTTP 200, заголовок `X-AvtoPult-Contract-Version: 1.0` и JSON со значениями
`contractVersion: "1.0"`, `status: "ready"` и массивом `checks`. Ответ `{ "ok": true }` означает,
что опубликована старая версия расширения.

## 6. Подключить агент без записи

Установить агент по `FIELD-INSTALL.md`, указав URL тестовой публикации. Значение
`ONE_C_ALLOW_WRITES` оставить равным `0`, затем выполнить:

```powershell
& 'C:\one-c-agent\diagnose-agent.ps1' `
    -NodeExe 'C:\one-c-agent\runtime\node.exe' `
    -AgentDirectory 'C:\one-c-agent'
```

Все проверки должны быть `ok` или явно `disabled`. Только после этого настроить профили,
выполнить нативную приёмку из `one-c-extension-source\P-13-INTEGRATION.md` и включить запись на
тестовой базе.

## 7. Контрольный обмен

Проверить по одному согласованному сценарию: заказ, повтор команды без дубля, изменение заказа,
счёт и PDF, частичная и полная оплата, возврат, зарплатный период. После каждого шага сверить
документ, сумму, статус и идентификатор в обеих системах. При первой ошибке вернуть
`ONE_C_ALLOW_WRITES` в `0`, перезапустить службу и сохранить логи; очередь и документы не удалять.

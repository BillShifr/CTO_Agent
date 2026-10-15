# Подключение боевой 1С к СТО

## 1. Распаковать комплект

Распаковать `СТО-1С-production-kit.zip` в `C:\Install`. В комплекте находятся инструкция, архив агента и
контрольные суммы. Готовый `.cfe` появится после выполнения следующего блока.

## 2. Блок специалиста 1С

Выполнить [инструкцию стороны 1С](P-13-ONE-C-PRODUCTION.md) полностью. Этот блок требует Конфигуратор
1С и доступ к копии и боевой базам. На выходе должны быть:

- проверенные `AvtoPult.cfe` и `AvtoPult.cfe.sha256`;
- протокол нативной приёмки на копии;
- боевое расширение с профилями и правами;
- адрес веб-публикации, логин чтения и логин обмена.

## 3. Установить агент — Windows-компьютер СТО

В кабинете СТО открыть интеграцию с 1С и получить код подключения.
Открыть PowerShell от имени администратора:

```powershell
& {
    $ErrorActionPreference = 'Stop'
    $zip = 'C:\Install\AvtoPult-OneCAgent-windows-x64.zip'
    $hash = ((Get-Content "$zip.sha256" -Raw -Encoding UTF8).Trim() -split '\s+')[0]
    $base = Read-Host 'Адрес публикации боевой 1С'
    $options = @{
        Archive = $zip
        ExpectedSha256 = $hash
        ApiUrl = 'https://cto24.kz/api/v1/'
        OneCBaseUrl = $base
    }
    if (([Uri]$base).Scheme -eq 'http') {
        if ((Read-Host 'Доступ к 1С идёт по доверенной локальной сети/VPN? ДА') -ne 'ДА') {
            throw 'Укажите HTTPS-адрес публикации 1С'
        }
        $options.AllowLocalHttp = $true
    }
    & 'C:\Install\install-package.ps1' @options
}
```

Ввести логины и пароли чтения/обмена 1С, затем код подключения СТО.
Если пакет уже распакован в `C:\one-c-agent`, но служба ещё не установлена:

```powershell
& 'C:\one-c-agent\setup-agent.ps1' -ApiUrl 'https://cto24.kz/api/v1/'
```

Для HTTP в доверенной локальной сети/VPN добавить `-AllowLocalHttp`.
Работающий агент обновлять из нового пакета, распакованного в `C:\Install\agent-new`:

```powershell
& 'C:\Install\agent-new\update-service.ps1' `
    -NodeExe 'C:\Install\agent-new\runtime\node.exe' `
    -CurrentDirectory 'C:\one-c-agent' `
    -ReleaseDirectory 'C:\Install\agent-new'
```

## 4. Выбрать справочники и проверить соединение

```powershell
& 'C:\one-c-agent\configure-mappings.ps1'
```

Выбрать организацию, виды цен товаров/услуг/закупки, склад 1С для каждого склада СТО
и нормочасы услуги без норматива. Подтвердить `ДА`.

```powershell
& 'C:\one-c-agent\diagnose-agent.ps1' `
    -NodeExe 'C:\one-c-agent\runtime\node.exe' `
    -AgentDirectory 'C:\one-c-agent'
```

Проверить отсутствие ошибок и подключение агента в кабинете СТО.
При `404` на `/hs/avtopult/v1/diagnostics` проверить публикацию на сервере 1С.

## 5. Включить запись и проверить рабочий заказ

После подтверждения настроек специалистом 1С:

```powershell
notepad.exe 'C:\ProgramData\AvtoPult\OneCAgent\agent-config.json'
```

Изменить только `"ONE_C_ALLOW_WRITES": "0"` на `"ONE_C_ALLOW_WRITES": "1"`, сохранить:

```powershell
Restart-Service AvtoPultOneCAgent
```

Создать согласованный рабочий заказ в СТО, проверить его в 1С, изменить состав,
выставить счёт, открыть PDF. При реальной оплате сверить сумму и статус в обеих системах.
При ошибке вернуть `ONE_C_ALLOW_WRITES` в `"0"` и перезапустить службу.

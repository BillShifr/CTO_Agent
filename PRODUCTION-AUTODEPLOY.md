# Автообновление агента на сервере 1С

## Что устанавливается

Один установочный пакет создаёт две Windows-службы:

- `AvtoPultOneCAgent` — агент обмена с 1С;
- GitHub Actions Runner — получает только задание деплоя этого репозитория.

Runner работает на том же Windows-сервере, где работает агент и доступна публикация 1С. Входящие
подключения к серверу не нужны: обе службы сами устанавливают исходящие HTTPS-соединения.

## Что подготовить один раз

В GitHub для `BillShifr/CTO_Agent`:

1. Создать environment `production` и назначить ответственного за подтверждение деплоя.
2. Открыть **Settings → Actions → Runners → New self-hosted runner** и скопировать одноразовый
   registration token. Команды со страницы выполнять не нужно.
3. Если репозиторий входит в организацию, создать отдельную runner group для production и разрешить
   ей workflow `.github/workflows/deploy-agent.yml` из ветки `main`.

На Windows-сервере потребуются права локального администратора, доступ к GitHub, `cto24.kz` и
публикации 1С, а также:

- одноразовый код подключения агента из АвтоПульта;
- логины и пароли пользователей 1С для чтения и записи;
- одноразовый GitHub runner registration token.

## Установка

Скопировать в `C:\Install` ZIP, соседний файл `.sha256` и `install-package.ps1`. Открыть PowerShell
от имени администратора:

```powershell
$zip = 'C:\Install\AvtoPult-OneCAgent-windows-x64.zip'
$hash = ((Get-Content "$zip.sha256" -Raw -Encoding UTF8).Trim() -split '\s+')[0]
$base = Read-Host 'Адрес публикации 1С'
& 'C:\Install\install-package.ps1' `
  -Archive $zip `
  -ExpectedSha256 $hash `
  -OneCBaseUrl $base `
  -AllowLocalHttp `
  -InstallProductionRunner `
  -RepositoryUrl 'https://github.com/BillShifr/CTO_Agent'
```

Если настроена runner group, добавить `-RunnerGroup 'ИМЯ_ГРУППЫ'`. Скрипт скрыто запросит секреты,
установит обе службы, ограничит ACL каталогов, включит автозапуск и выполнит диагностику. При сбое
runner после успешной установки агента повторить только:

```powershell
& 'C:\one-c-agent\setup-production-runner.ps1' `
  -RepositoryUrl 'https://github.com/BillShifr/CTO_Agent'
```

## Как выполняется обновление

После успешного `Agent checks` для push в `main` workflow `Deploy production agent`:

1. ждёт подтверждения environment `production`;
2. скачивает Windows-архив именно из проверенного CI run;
3. сверяет внешний SHA-256 и внутренний `SHA256SUMS`;
4. сохраняет действующую версию рядом с `C:\one-c-agent`;
5. обновляет службу;
6. ждёт новый heartbeat, принятый облаком;
7. автоматически возвращает прежнюю версию, если служба или heartbeat не восстановились.

Runner дополнительно проверяет репозиторий, workflow, событие и ветку до запуска задания. Задания
из pull request и других workflow он отклоняет.

## Ручное обновление, восстановление и проверка

```powershell
# Обновить из локального проверенного архива
$zip = 'C:\Install\AvtoPult-OneCAgent-windows-x64.zip'
$hash = ((Get-Content "$zip.sha256" -Raw -Encoding UTF8).Trim() -split '\s+')[0]
& 'C:\one-c-agent\deploy-agent-release.ps1' `
  -Archive $zip -ExpectedSha256 $hash

# Восстановить указанную резервную версию
& 'C:\one-c-agent\restore-agent-release.ps1' `
  -BackupDirectory 'C:\one-c-agent.previous.ГГГГММДДччммсс'

# Проверить службы, ACL, диск, GitHub, 1С, облако и heartbeat
& 'C:\one-c-agent\diagnose-production.ps1'
```

JSON-отчёты сохраняются в `C:\ProgramData\AvtoPult\Deployment\reports`. Журналы агента находятся
в `C:\one-c-agent\logs`, журналы runner — в `C:\actions-runner-avtopult\_diag`.

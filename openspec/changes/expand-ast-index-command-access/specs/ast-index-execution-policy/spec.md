# Spec Delta

## Purpose

Определить полный доступ к AST-анализу и управлению индексом для исследователей и оркестратора, не превращая разрешение специализированного CLI в общий shell-доступ или установку глобальных интеграций.

## ADDED Requirements

### Requirement: Полная поверхность AST анализа и управления индексом

Система SHALL допускать одиночную команду доверенного `ast-index` со всеми командами анализа и управления индексом и их CLI arguments/options, кроме явно исключённых инсталляторов интеграций. Система MUST NOT поддерживать отдельный ограниченный список допустимых analysis verbs или повторять проверки допустимости их аргументов, принадлежащие самому CLI.

#### Scenario: Анализ symbols и зависимостей
- **WHEN** допущенный actor вызывает `unused-symbols`, `unused-deps`, `hierarchy`, `implementations`, `deps`, `dependents`, `module-route` или другую analysis-команду `ast-index`
- **THEN** policy допускает исполнение без отдельного разрешения каждого verb

#### Scenario: Управление индексом и roots
- **WHEN** допущенный actor вызывает `rebuild`, `update`, `clear`, `watch`, `add-root`, `remove-root` или `list-roots`
- **THEN** policy допускает операцию самого AST-инструмента, включая изменение его index/cache/root configuration
- **AND** допуск не предоставляет право на отдельную произвольную запись source или canonical workflow state

#### Scenario: Поддерживаемые global и command options
- **WHEN** команда использует global `--format` / `--walk-up` или command options, например `--from`, `--to`, `--module`, `--lang`, `--limit`
- **THEN** policy не отклоняет её из-за отсутствия этих options в старом AST allowlist

#### Scenario: CLI сам валидирует свою грамматику
- **WHEN** одна безопасная команда AST содержит неизвестный verb, неподдерживаемый option или недопустимое значение CLI argument
- **THEN** policy допускает передачу в CLI, а потребитель получает настоящий CLI result/error, не подменённый policy-отказом

### Requirement: Буквальные quoted arguments без shell исполнения

Система SHALL поддерживать quoted/escaped буквальные arguments для SQL, structural patterns и путей с пробелами. Система MUST NOT допускать активные shell expansions, substitutions, operators, redirects, command lists или запуск дополнительного executable.

#### Scenario: SQL содержит пробелы и буквальный separator
- **WHEN** actor вызывает `ast-index query 'SELECT name FROM symbols WHERE name LIKE "%;%"' --limit 20`
- **THEN** SQL передаётся как один буквальный argument, а semicolon внутри quotes не рассматривается как вторая shell-команда
- **AND** SQL restrictions самого `ast-index query` остаются ответственностью CLI

#### Scenario: Structural pattern содержит dollars и скобки
- **WHEN** actor вызывает `ast-index agrep 'router.launch($$$)' --lang typescript`
- **THEN** pattern передаётся буквально без shell expansion или command substitution

#### Scenario: Путь содержит пробелы
- **WHEN** actor вызывает `ast-index outline 'src/feature area/service.ts'`
- **THEN** CLI получает один path argument с пробелом

#### Scenario: Активная shell substitution
- **WHEN** команда содержит `$(...)`, backticks или variable expansion вне single quotes и без буквального escaping, в том числе внутри double quotes
- **THEN** policy запрещает её до исполнения

#### Scenario: Shell composition или redirect
- **WHEN** после AST-команды используются активные `;`, `&&`, `||`, `|`, `&`, newline, `<`, `>` или process substitution
- **THEN** policy запрещает всю команду, включая AST-часть

#### Scenario: Некорректная quoting граница
- **WHEN** command string содержит незакрытые quotes, неподдерживаемую shell syntax или NUL
- **THEN** policy отказывает безопасно и ничего не исполняет

### Requirement: Исключение глобальных инсталляторов

Система SHALL запрещать исполнительные subcommands `install-claude-plugin` и `install-codex-mcp` для данной AST capability независимо от расположения global options и формы quoting executable/subcommand. Система MUST отличать настоящий subcommand от совпадающего текста внутри analysis argument. Запрет распространяется и на вызов installer с `--dry-run`; installer не входит в разрешённую capability.

#### Scenario: Прямой installer
- **WHEN** actor вызывает `ast-index install-claude-plugin` или `ast-index install-codex-mcp`
- **THEN** policy запрещает команду до изменения глобального plugin/config state

#### Scenario: Installer после global options
- **WHEN** actor вызывает `ast-index --format json --walk-up install-codex-mcp --dry-run` или эквивалентную single-command форму с `--format=json`
- **THEN** policy запрещает installer, а options не позволяют обойти исключение

#### Scenario: Название installer является поисковым argument
- **WHEN** actor вызывает `ast-index search install-codex-mcp` или использует эту строку внутри quoted SQL/pattern
- **THEN** policy не принимает буквальный analysis argument за installer subcommand и допускает analysis-команду

### Requirement: Доверенный executable и неизменные host boundaries

Система SHALL разрешать AST capability только через существующую доверенную host/claim admission и native worker role opt-in либо authenticated artifact-scoped orchestrator authority. Система MUST сохранять запрет подмены executable, env и tool cwd; расширение argv MUST NOT ослаблять источник authority.

#### Scenario: Оба существующих потребителя
- **WHEN** `omp-analyst` / `omp-tech-researcher` имеет действительный native binding и включён в роль, разрешающую AST Bash, либо caller имеет authenticated orchestrator artifact scope
- **THEN** после существующих host/claim проверок ему доступна одинаковая расширенная AST command surface

#### Scenario: Analysis data похоже на destructive shell
- **WHEN** любой из двух допущенных потребителей вызывает literal `ast-index search rm`, `ast-index search 'mkfs'` или `ast-index search 'rm .work-state/run-control.json'`
- **THEN** существующие composed gates не принимают analysis arguments за executable mutation и допускают AST invocation
- **AND** quoted canonical path не означает право изменить canonical state

#### Scenario: Буквальный redirect text не является write target
- **WHEN** любой из двух допущенных потребителей передаёт в analysis argument буквальную строку `'dd of=/outside > /outside'`, а отдельный probe использует активный redirect или вторую shell-команду
- **THEN** literal argument не блокируется как outside-scope запись, но active-shell probe запрещён до исполнения

#### Scenario: Model-authored actor не создаёт разрешение
- **WHEN** caller подставляет agent name, копирует session-manager fields или не имеет действительной owner/claim authority
- **THEN** AST command string сам по себе не даёт доступа и исполнение запрещено

#### Scenario: Подменённый executable или wrapper
- **WHEN** command использует `./ast-index`, произвольный путь к одноимённому файлу, `bash -c`, `env`, shell function или assignment-prefix вместо доверенного executable
- **THEN** policy запрещает её

#### Scenario: Env или чужой cwd
- **WHEN** tool input задаёт env, включая `AST_INDEX_DB_PATH` / `PATH`, либо cwd, не равный trusted worktree cwd
- **THEN** policy запрещает её; AST CLI options не разрешают подмену tool execution context

#### Scenario: Descriptor-safe AST recognition
- **WHEN** этап распознавания AST проверяет metadata с accessor вместо собственного command value
- **THEN** AST recognition отказывает без исполнения getter, а отклонённая AST-команда не исполняется

### Requirement: Watch сохраняет существующий lifecycle процесса

Система SHALL допускать `ast-index watch` как долгоживущую AST-команду через существующий process lifecycle host. Система MUST NOT создавать скрытый watcher, расширять timeout/retry policy или останавливать ранее запущенный пользовательский watcher ради этой capability.

#### Scenario: Собственный watcher можно остановить
- **WHEN** допущенный actor запускает watch через host process lifecycle и затем завершает принадлежащий ему процесс поддерживаемым host action
- **THEN** watcher перестаёт обновлять индекс и не оставляет собственный процесс; чужой watcher не затрагивается

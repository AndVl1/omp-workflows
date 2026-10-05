# Design

## Context

Мотивация и согласованная граница — `proposal.md`; observable contract — `specs/ast-index-execution-policy/spec.md`. `ast-index 3.44.2 --help` показывает analysis, index management, project roots, programmatic access и два глобальных installer commands. Пользователь выбрал весь analysis/index management без инсталляторов.

Сейчас `packages/core/src/gates/read-only-bash.ts` сначала проверяет metadata/executable, затем применяет character whitelist, space split и маленький verb/argument whitelist. SQL quotes, `agrep 'router.launch($$$)'` и большинство штатных CLI команд этот путь не пропускает. Предикат уже используется и read-only worker Bash gate, и artifact-scoped веткой `packages/core/src/gates/orchestrator-write.ts`. `readOnlyBashAgents` в core registration выводит агент из native binding; приватный бандл явно включает только двух исследователей.

Existing `simpleGitWords` в orchestrator gate тоже намеренно запрещает quotes и не является готовым shell lexer. Main-spec inventory пуст; новая capability не дублирует опубликованный main spec. Это planning-only change, а не фиксация уже выполненного расширения.

Baseline локальных исправлений `b57045e`: к strict parser добавлен unused-symbols
с relative --module, --export-only, bounded --limit и json/text --format.
Эта реализация сохраняет per-verb/option whitelist и не является описанным ниже
полным cutover. AST-only workers не получают writer/Node права; диагностика с
general Bash публикует JSON.stringify envelope через уникальный файл и outputs_path.


## Goals / Non-Goals

**Goals:**
- Одна implementation boundary для обоих существующих потребителей; unchanged public registration API и host authority path.
- Проверка безопасности shell command, а не повторная реализация всей грамматики AST CLI.
- Поддержка буквальных SQL/pattern/path arguments и устойчивого исключения двух installers.

**Non-Goals:**
- Новый AST tool, общий shell parser/runner, дополнительный process manager, workspace dependency или blanket permission для всех read-only агентов.
- Изменение sanitized Git policy, receipts/recovery, SDK embedding initialization, workflow profiles или пользовательских runs/watchers.
- Универсальная гарантия отсутствия побочных эффектов любого будущего AST binary: инструменту доверяют как специализированному executable, но не как shell.

## Decisions

### 1. Сохранить existing shared predicate и consumer seams

Literal AST recognition остаётся централизованным в `read-only-bash.ts`. В existing tool-call composition core вычисляет решение один раз на вызов после разрешения trusted context и передаёт runtime-derived результат существующим composed gates; это не model-authored flag и не новый публичный tool/schema. Не менять набор доверенных executable spellings: `ast-index`, `/opt/homebrew/bin/ast-index`, `/usr/local/bin/ast-index`. Нельзя разрешать любой путь, который заканчивается на `ast-index`: файл в workspace может быть другим executable.

Сохранить plain input object / own descriptor проверки, string transport, отсутствие env overrides и разрешение cwd только при совпадении с trusted cwd. Native role/host/claim checks остаются до command predicate. Новый tool или расширение generic Bash были отвергнуты как лишняя capability и второй путь контроля.

Полный cutover затрагивает существующие `orchestratorWriteGate`, `workerWriteScopeGate`, `safetyGuard` и их композицию в `packages/core/src/index.ts`, а не только AST predicate. Сейчас AST allow не завершает orchestrator gate: поздние raw-command heuristics считают `rm`, `mkfs`, quoted canonical paths или `dd of=... > ...` внутри analysis argv executable mutations. Для допущенной literal AST invocation shell-only canonical/source/write-scope/destructive heuristics не интерпретируют argv как shell syntax. Это разграничение нужно до raw canonical preflight и до поздних heuristics; защита реальных non-AST mutations, writes/edits и предшествующая authority admission остаются неизменными.

Существующее descriptor-safe распознавание metadata сохраняется только как гарантия AST predicate. Этот change не обещает отсутствие getter dereference во всех других legacy gates и не включает отдельный global input-normalization refactor.

### 2. Literal single-command recognition вместо space split

В существующем модуле добавить небольшой приватный однопроходный recognizer буквальных argv: outside/single-quote/double-quote состояния, concatenate adjacent quoted segments, shell-correct literal escaping и границы tokens. Он не исполняет команды и не использует `eval`, subprocess или чтение environment. Нет нужды превращать строгий unquoted Git parser в общий shared shell parser.

Допустимы quoted SQL, structural patterns, Unicode и spaces. Активные substitutions/variable/tilde/glob/brace expansions, operators, redirects, comments, assignment prefixes, command groups и line continuations запрещены. Буквальные metacharacters внутри single quotes или корректного escaping не равны shell execution. Неоднозначная/неподдерживаемая syntax, NUL и незакрытые quotes дают отказ.

Важно не удалить только старую character regex и не проверять один prefix `ast-index`: это пропустит shell execution. Также нельзя запрещать любой `$`, `;` или installer substring независимо от quoting/позиции — такая проверка снова сломает буквальные analysis arguments.

### 3. Доверять AST grammar, исключить только исполнительные installers

После проверки executable разрешить остальные literal argv без per-analysis-verb whitelist и без собственных проверок CLI limit/format/module/pattern. Невалидная CLI grammar даёт настоящий CLI error. SQL допускается как argv, но собственный SELECT-only контракт `ast-index query` не дублируется в Bash policy.

Выделить actual subcommand после штатных global options, учитывая `--format VALUE`, `--format=VALUE`, `--walk-up`, help/version и option terminator. Запретить два installers по точному subcommand, даже при quoted spelling и `--dry-run`; не искать их названия во всех tokens. `search install-codex-mcp` не устанавливает интеграцию. Обе потребляющие ветки должны получить это одно решение; сообщение отказа и docs описывают binary-only permission и installer exceptions, а не старый lookup-only whitelist.

### 4. Existing lifecycle для watch и явные cache effects

`watch` разрешён как AST operation. Его запуск/остановка и timeout принадлежат существующему Bash process lifecycle, а не новому runtime. `clear`, root management и index refresh могут изменять index/cache/root configuration; read-only здесь относится к production source и generic file-write capability. CLI `--walk-up` — аргумент самого AST, не разрешение менять tool cwd/env. Не останавливать и не перенастраивать пользовательский watcher.

### 5. Один writer на область и integration ownership

До apply назначается один владелец core gates/tests/README и один владелец private agent instructions; root changelog и общие экспортируемые контракты пишет владелец интеграции. Для этой небольшой связанной работы один implementation owner может совмещать все три обязанности. Согласованный контракт — delta spec; параллельные записи в общие gates, registration, manifests/lockfile запрещены. Делегированный readonly review не становится вторым writer.

## Risks / Trade-offs

- **Shell quoting/escaping даёт обход границы** → consumer-visible негативные cases для substitutions, operators, prefix assignments, malformed quotes и escaped/quoted executable; runtime sentinel остаётся неизменным после отклонённых probes.
- **Installer спрятан после options, либо benign search ошибочно запрещён** → actual subcommand classification; positive/negative pairs для `--format` в обеих формах, quoted command и совпадающего analysis argument.
- **Будущая версия CLI добавляет побочные эффекты** → явно выбранная доверенная binary capability, без обещания universal readonly sandbox; два известных installer verbs исключены. Обновление CLI с новыми глобальными mutation commands требует отдельной проверки scope, а не открытия shell.
- **Неполный cutover оставляет lookup-only инструкции** → обновить существующие prompts/README/denial messages; убрать obsolete tests, которые фиксировали incidental CLI option validation, а не security boundary.
- **Watch оставляет процесс или задевает чужой индекс** → реальный smoke только в owned scratch с owned index и собственным process handle; контролируемая остановка и проверка исчезновения собственного процесса.

## Migration Plan

1. В apply заменить старую AST verb/argument policy внутри existing shared gate. Не добавлять compatibility shim или второй opt-in.
2. В тот же cutover перевести composed gates на различение допущенного literal AST и executable shell mutation, затем обновить tests и инструкции двух private агентов; docs говорят о полном AST CLI, двух exceptions и сохраняющихся host/shell boundaries. Дополнительное чтение argv как raw shell после AST admission не допускается.
3. После всех edits выполнить focused registered-gate regressions и реальные CLI smoke в owned scratch: dependency/unused analysis, quoted query, `agrep` при установленном `sg`, index/root management и остановка собственного watch. Зафиксировать source/canonical sentinel SHA и реальные CLI results; отсутствие `sg` — конкретный prerequisite, не synthetic PASS.
4. После smoke убрать собственные helpers/processes, обновить существующий Unreleased changelog, выполнить workspace build/typecheck/tests и проверить OpenSpec tasks. Требуется reload OMP для загрузки нового gate; чужой run не продолжать в QA.
5. При rollback вернуть весь scoped implementation cutover вместе с tests/prompts/docs, не изменяя index contents, пользовательские конфиги или сохранённый workflow state. Этот proposal не архивируется до завершённого apply.

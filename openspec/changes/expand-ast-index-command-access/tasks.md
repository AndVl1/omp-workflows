# Tasks

Реализованный узкий baseline `b57045e` (unused-symbols/ограниченные flags) и writer-aware
publication guidance отражены в specs. Они не выполняют полный argv/quoted/roots/watch
cutover ниже; unchecked tasks остаются pending, не проставляются по baseline smoke.

## 1. Общая AST command boundary

- [ ] 1.1 Назначить одного implementation/integration owner согласно design и заменить в `packages/core/src/gates/read-only-bash.ts` character/space split на однопроходное распознавание одной команды с буквальными quoted/escaped argv; сохранить trusted executable и metadata boundaries. Проверка: подготовленные в группе 2 cases различают quoted SQL/pattern/path и активные substitutions/operators; malformed quotes/NUL дают отказ; direct AST predicate metadata cases сохраняют отсутствие getter execution только на этапе распознавания AST.
- [ ] 1.2 Убрать per-analysis-verb/argument allowlist, допустить полный analysis/index CLI и global options; исключать только actual `install-claude-plugin` / `install-codex-mcp`, учитывая option-prefix и quoting, не совпадения внутри analysis arguments. Проверка: полный CLI surface проходит policy, оба installer variants отклоняются, неизвестная CLI grammar доходит до CLI error вместо policy error.
- [ ] 1.3 Перевести существующую композицию gates в `packages/core/src/index.ts`, orchestrator/worker write-scope в `orchestrator-write.ts` и `safety.ts` на единое runtime-derived AST решение: допущенные literal argv не должны повторно интерпретироваться raw shell mutation heuristics, в том числе до canonical preflight. Обновить denial guidance без нового tool/opt-in; сохранить host/claim, actual non-AST source/canonical/write-scope/destructive и sanitized Git protections. Проверка: registered сценарии группы 2 допускают literal destructive-looking data у обоих actors, но отклоняют matching active-shell mutations.

## 2. Поведенческие regression boundaries

- [ ] 2.1 Обновить `packages/core/test/read-only-bash.test.ts` cases для SQL/structural patterns/paths, single/double quotes, escaping, adjacent quoted segments, Unicode; добавить отрицательные active substitutions, expansions, operators, redirects, comments, malformed inputs и executable wrappers. Удалить obsolete expectations, фиксирующие старый verb whitelist или incidental CLI option validation. Проверка: focused suite допускает literal argv и отклоняет каждую независимую shell-execution boundary, без source-text/wording assertions.
- [ ] 2.2 Добавить позитивные/негативные installer classification cases с global flags в обеих `--format` формах, quoted spelling, `--dry-run`, option terminator и installer text в search/SQL. Проверка: запрет нельзя обойти options/quoting; совпадающий analysis argument не блокируется.
- [ ] 2.3 Расширить существующий registered fixture для trusted readonly worker и authenticated artifact-scoped orchestrator на dependency/unused/query/root/index operations, literal `rm`, `mkfs`, canonical path и `dd of=/outside > /outside` arguments; добавить matching active-shell отрицательные probes. Сохранить adversarial cases для copied session-manager, model-authored agent, env/cwd overrides и произвольного Bash. Проверка: все composed gates допускают AST data, но не executable mutations; authority выводится из trusted binding, не AST string.

## 3. Runtime и существующие consumer instructions

- [ ] 3.1 Обновить только существующие инструкции `omp-analyst.md` / `omp-tech-researcher.md` и core README: полный AST analysis/index CLI, два installer exceptions, literal quoting и сохранившиеся env/cwd/source boundaries. Проверка: документы не обещают generic Bash и явно допускают `query`, `agrep`, `clear`, `watch`, roots и CLI `--walk-up`.
- [ ] 3.2 Выполнить реальный установленный CLI smoke через зарегистрированные gates в owned scratch/index: dependency/unused analysis, schema-grounded quoted SQL с ожидаемыми fixture rows, structural search с `sg`, `clear`→`rebuild`→повторный lookup и add/list/remove roots. Проверка: реальные CLI outputs отражают fixture symbols/roots, source и canonical sentinels сохраняют SHA; prerequisite `sg` подтверждён или явно обозначен как missing, не mock PASS.
- [ ] 3.3 Через existing host process lifecycle запустить собственный `ast-index watch` в том же isolated runtime, наблюдать обновление индекса после отдельного fixture edit и остановить только собственный process handle. Проверка: изменённый symbol виден в AST output, собственный процесс отсутствует после остановки, чужой watcher и пользовательский run не затронуты.

## 4. Интеграционное подтверждение

- [ ] 4.1 После runtime proof обновить существующий Unreleased changelog и выполнить workspace `npm run build`, `npm run typecheck`, `npm test` после всех implementation edits. Проверка: команды PASS, нет leftover старого lookup-only runtime path или compatibility shim.
- [ ] 4.2 Получить независимый readonly review quoting/installer/authority boundaries, выполнить `openspec validate expand-ast-index-command-access --strict` и обновить task checkboxes только по exercised evidence. Проверка: отсутствие неустранённых findings, strict validation PASS и итоговый handoff явно отделяет runtime CLI proof от не выполнявшихся live SDK/provider сценариев.

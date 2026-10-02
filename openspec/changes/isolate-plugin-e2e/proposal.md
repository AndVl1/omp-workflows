# Proposal

## Why

Текущий UX E2E создаёт scratch-проект, но использует `npm link`, рабочий профиль omp и наследуемое окружение: проверяемая сборка, глобальные плагины и состояние пользователя не имеют надёжной границы. Нужен повторяемый запуск реального omp без вмешательства в продолжающиеся рабочие сессии и без ручного конструирования окружения агентом при каждом тесте.

## What Changes

- Ввести один скриптуемый lifecycle E2E-окружения: подготовка, проверка готовности, запуск/перезапуск сессий, остановка, сбор evidence и очистка. Настройка задаётся версионируемым manifest; команды возвращают короткий результат и машиночитаемый JSON, без необходимости LLM для подготовки.
- На `prepare` находить актуальный установленный `omp`, проверять совместимость и сохранять автономный снимок runtime вместе с core/fullstack и их зависимостями; digest закрепляется за run. Обновление локальной установки влияет только на новые runs. Переиспользовать проверенный кэш, не устанавливать omp заново на каждый тест и не ссылаться на живой checkout.
- **BREAKING**: убрать глобальные `npm link`, неявный host profile/config/discovery и запуск произвольного неподготовленного scratch через legacy path. Существующие e2e-команды переводятся на единый изолированный lifecycle без небезопасного fallback.
- Разделить home/config/plugin discovery, workspace, временные файлы, session state и logs каждого прогона. До сценария проверять управляемые источники ресурсов и фактическое поведение отдельного omp-процесса с контрольными плагинами; не выдавать перечень переданных путей за полный native inventory.
- Переиспользовать текущую авторизацию установленного omp для реальных provider-backed прогонов: явный opt-in поднимает штатный shared `omp auth-broker serve` над существующей локальной auth DB; альтернативы — внешний native broker и allowlist API-key env. Не копировать OAuth credentials в тестовое окружение. Конкурирующие обычные omp-клиенты вне broker остаются отмеченным refresh-риском, а не ложной гарантией.
- Сохранять окружение между сессиями одного прогона для resume, но отделять его от других прогонов. Очистка завершает только принадлежащие прогону процессы, удаляет временные секреты и оставляет очищенное evidence.
- Добавить исполняемые рецепты smoke/isolation/resume и короткий операторский runbook: повторный запуск по manifest, а не импровизированные shell-инструкции.
- Добавить отдельный synthetic OAuth regression без аккаунта и LLM: настоящие native AuthStorage/store/broker/client из закреплённой тестовой зависимости, управляемый loopback token endpoint и temporary DB. Проверять конкурентное обновление и сохранение credentials, явно отделяя component/process integration от неизменённого CLI serve, live provider smoke и межпроцессного single-flight обычного omp.

## Capabilities

### New Capabilities

- `isolated-plugin-e2e`: воспроизводимая подготовка и lifecycle изолированного E2E, идентичность runtime/плагинов, контролируемый доступ к авторизации, проверяемая неизменность рабочей установки и scoped evidence.

### Modified Capabilities

Нет. Durable specs пока отсутствуют. Delta `run-context-isolation` в активном change `run-lifecycle` описывает authority workflow внутри worktree, а не изоляцию тестовой установки; этот change её не изменяет.

## Impact

- `packages/e2e/src/{cli,server,report}.ts`, e2e tests/fixtures/scenarios и package scripts; новые внутренние модули подготовки окружения и manifest в том же пакете, без второго harness.
- Root `package.json`, `packages/e2e/README.md`, e2e changelog и общий changelog при реализации: фиксированные команды и отказ от host-dependent quick start.
- Пакетирование core/fullstack используется как вход; workflow engine и состояние `run-lifecycle` не мигрируются. Причина текущих затруднений с resume не объявляется установленной и не исправляется этим change.
- Внешняя предпосылка: совместимая локальная установка omp с контролируемым discovery и нативным broker-клиентом для OAuth; snapshot и compatibility probe выполняются при `prepare`. По явному выбору оператора harness может запустить штатный broker, читающий текущую host auth DB и создающий свой защищённый broker-token файл; глобальные плагины/config не меняются. Остановка общего broker — отдельное адресное действие, не побочный эффект cleanup run.
- Не входят: Docker/VM, OS security sandbox, защита от произвольной shell-команды от имени пользователя, новый auth service, гарантия идентичности ответов LLM, изоляция общих provider quotas/billing. Допускаются штатные изменения credentials на стороне выбранного auth broker, но не изменения глобальных плагинов/config тестовым harness.

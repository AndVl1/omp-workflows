# CTO Sub-Orchestration — E2E Scenario

Slug: cto-suborchestration · Дата: 2026-08-04 · Статус: план (не выполнен)

Персистентный чеклист. Перед каждым прогоном — ПЕРЕЧИТАТЬ. Выполненные `[x]`
не повторяются; продолжать с первого `[ ]`. Ошибка → откат с описанием.

## Подготовка (однократно)

- [ ] Scratch-проект: `mktemp -d /tmp/cto-e2e-XXXX`, `git init`, фиктивный репо (2 файла: `backend/README.md`, `frontend/README.md`).
- [ ] `.omp/teams.json` в scratch: 2 команды (`backend` scope `backend-kotlin`, `frontend` scope `frontend`), lead `team-lead`, profile `lightweight`.
- [ ] `.omp/escalation.json`: `{"adapter": "http", "http": {"url": "https://httpbin.org/post"}}` — наблюдаем отправку, ответ не ждём (или локальный echo-сервер, см. ниже).
- [ ] Свежая omp-сессия в scratch (плагин установлен, команды скопированы в `.omp/commands/` — проверить `cto/` есть).
- [ ] Проверка команд: `/cto` (usage), `/do-work` (usage) — обе отвечают.

## Сценарий 1: декомпозиция и параллельные команды

- [ ] Ввод: `/cto Add a hello endpoint to the backend and a status page to the frontend`
- [ ] Ожидание: CTO-промпт с таблицей команд (backend + frontend), discipline-блок, упоминание max 8 / depth 2.
- [ ] Главный агент формирует TeamPlan (`.work-state/cto/<id>/state.json` существует, `teams.length == 2`), спавнит 2 lead'а (по одному на команду).
- [ ] Каждый lead спавнит воркеров (`task`), воркеры НЕ спавнят сами (проверка: в транскрипте нет вложенных task-цепей глубже lead→worker).
- [ ] Команды пишут свои артефакты: `.work-state/artifacts/<team>/` (discovery/implementation/dod.json).
- [ ] Обе команды закрывают DoD (dod.json: items met + evidence).
- [ ] Integration: ветки/файлы слиты, `integration_review` с вердиктом, `.work-state/cto/<id>/state.json` → `integration.status == done`.
- [ ] Финальный summary-артефакт с per-team статусами.

## Сценарий 2: асинхронная эскалация (blocker)

- [ ] Поднять локальный echo-сервер (отвечает 200 на POST, пишет тело в `/tmp/cto-e2e-esc.log`); `.omp/escalation.json` указывает на него.
- [ ] Ввод: `/cto [AUTONOMOUS] ...` с вопросом, который lead не может решить → эскалация level=blocker в outbox (`.work-state/cto/<id>/outbox/<esc>.json`).
- [ ] Dispatcher (session_start) отправляет POST на echo-сервер; в `/tmp/cto-e2e-esc.log` — тело эскалации БЕЗ секретов (санитизация R4).
- [ ] Outbox-файл перемещён в `outbox/sent/`; команда, ждавшая ответ, в статусе `parked` (`pause.kind == background_wait`).
- [ ] Остальные команды/пути ПРОДОЛЖАЮТ работу (не блокируется весь run).
- [ ] Положить ответ файлом: `.work-state/cto/<id>/answers/<esc>.json` `{id, answer, at, by}`.
- [ ] На следующем чекпоинте команда применяет ответ, переходит в `in_progress`, run завершается.

## Сценарий 3: отказ команды изолирован

- [ ] Задача с заведомо ломающейся командой (например, backend с некорректным заданием) → команда `failed`.
- [ ] Вторая команда завершается `done` независимо.
- [ ] CTO на integration: re-spawn с причиной из gate ИЛИ вырезает скоуп ИЛИ эскалация; run не падает целиком.
- [ ] `state.json`: одна команда `failed`, integration `failed` с note.

## Критерии приёмки

- [ ] 3 сценария пройдены на рабочем провайдере (не minimax-класс в live-делегации).
- [ ] Все шаги отмечены `[x]`/`[ ]` честно; отчёты в `vibe-report/`.

## Live smoke (2026-08-04, omp 17.2.6, DeepSeek V4 Flash) — ВЫПОЛНЕН

Полная цепочка `/cto` проверена в реальной PTY-сессии на scratch-проекте (`/tmp/cto-smoke`):

- [x] Команда скопирована в `.omp/commands/cto/` (вместе с `_lib/`), загружена, `ui.notify` «cto: … (decomposition pending)».
- [x] Промпт-контракт: таблица команд из `.omp/teams.json` (backend + frontend), discipline-блок, «max 8, depth 2», «Begin: decompose…».
- [x] Главный агент исполнил контракт: `.work-state/cto/hello-status/team-plan.md` (2 команды, scope-слайсы, lightweight, separate worktree для независимых слайсов), `decisions.md` (D1-D10 с «почему»), initial commit.
- [x] Лестница эскалации работает: CTO решил всё сам (D1-D10), эскалаций на пользователя не потребовалось.
- [x] Провайдер рабочий; никаких фризов (в отличие от node-pty e2e — PTY-сессия напрямую).

Замечание: агент пишет state/plan файлами (не может вызвать TS `runCto`) — двухслойность подтверждена; движок остаётся контрактом для потребителей/будущей harness-интеграции. Полные сценарии 1-3 (blocker-эскалация, отказ команды) — к выполнению.

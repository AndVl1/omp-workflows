# Design

## Context

Мотивация и граница авторизации описаны в `proposal.md`. Design обязателен: меняются подготовка пакетов, запуск процессов, хранение evidence и доступ к credentials.

Наблюдения по текущему коду:

- `packages/e2e/src/cli.ts:143–195`: bootstrap создаёт git scratch, вызывает `npm link` для core/fullstack и копирует custom-TS commands. Комментарий у link объясняет прежнюю проблему unpublished peer dependency; замена на произвольный `npm install` недостаточна.
- `packages/e2e/src/server.ts:60–74,352–382,1034–1128`: окружение наследуется почти целиком; host config читается отдельно от child env и передаётся через `--config`; executable выбирается через `OMP_BIN`/PATH. Изолированный `--session-dir` не изолирует весь runtime.
- В `startTestSession` transcript обнуляется при старте. Для restart journey это теряет evidence прежней сессии.
- `packages/e2e/src/report.ts:194–213`: выбирается самый свежий глобальный omp log. Existing stop уже проверяет принадлежность PID и избегает broad kill; эту основу сохранить и распространить на run cleanup.
- `packages/e2e/test/server.test.ts` покрывает reconnect, session metadata, user overlay и live-session guard; cli tests не исполняют реальный `npm link`. Existing `detach.test.ts` запускает настоящий omp. Изменить реальные consumers, а не добавить альтернативный безопасный path рядом с прежним.
- В доступных исходниках установленного `@oh-my-pi/pi-coding-agent` обнаружены `session/auth-broker-config.ts`, `cli/auth-broker-cli.ts` и shared `pi-ai/src/auth-broker/*`. Broker URL/token передаются через `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN`; broker использует native AuthStorage. Refresher документирует single-flight в AuthStorage, но это не доказывает координацию независимого локального клиента и broker-процесса.
- `omp auth-broker serve` открывает native agent DB и создаёт token при необходимости. По новому явному решению оператора допускается только opt-in запуск штатного broker-manager с подтверждённой ownership, без скрытого prepare-side эффекта; это риск refresh-конкуренции с обычной рабочей сессией, а не гарантия её отсутствия. Совместимость выбранного executable отдельно проверяется.
- Native discovery включает не только entrypoint, но и sibling skills/hooks/tools/commands/rules/prompts/MCP. Изоляция должна охватывать эти источники. CLI help содержит `PI_CODING_AGENT_DIR`, но он не объявляется единственной границей всех путей.

Durable specs отсутствуют. Активный `run-lifecycle` остаётся отдельным change: его run authority не равен E2E run identity. Ни его state, ни незавершённые пользовательские сессии этот change не меняет.

## Goals / Non-Goals

**Goals:**

- Один локальный harness и фиксированный набор команд вместо ad hoc shell/setup, пригодный для человека и агента.
- Воспроизводимость входов и среды, включая незакоммиченные правки через snapshot; не воспроизводимость стохастического ответа модели.
- Низкая стоимость повторных запусков: content-addressed reuse runtime/packages, отсутствие обязательного daemon/VM, LLM только в явно live-сценариях.
- Переиспользование действующей авторизации через узкий native seam с явной диагностикой prerequisites.

**Non-Goals:**

- Защита host filesystem от произвольного shell-кода, отдельная ОС, новый auth proxy или миграция пользовательского login.
- Hot reload артефактов в существующем прогоне, автоматический upgrade runtime, починка уже повреждённого workflow state.
- Автоматическое копирование всех локальных пользовательских плагинов, агентов, MCP и model configuration.

## Decisions

### 1. Единый CLI и конкретные скрипты

Реализация остаётся в `packages/e2e`, существующий `ux-e2e` — единственный lifecycle owner. Root npm scripts служат тонкими фиксированными entrypoints, а не вторым набором shell-алгоритмов:

| Скрипт | CLI | Назначение |
|---|---|---|
| `npm run e2e:prepare -- --config <file> --run <id> --json` | `ux-e2e prepare` | Проверить входы, собрать/снять артефакты, создать окружение, выдать manifest |
| `npm run e2e:doctor -- --manifest <path> --json` | `ux-e2e doctor` | Проверить целостность, roots, runtime capabilities, auth readiness без LLM |
| `npm run e2e:start -- --manifest <path>` | `ux-e2e start` | Запустить настоящий PTY в подготовленном окружении |
| `npm run e2e:stop -- --manifest <path>` | `ux-e2e stop` | Остановить сессию без удаления state |
| `npm run e2e:report -- --manifest <path> --json` | `ux-e2e report` | Сохранить очищенное scoped evidence |
| `npm run e2e:cleanup -- --manifest <path> --json` | `ux-e2e cleanup` | Адресно завершить процессы и удалить временную среду |
| `npm run e2e:verify -- --manifest <path> --suite isolation` | `ux-e2e verify` | Детерминированные isolation-сценарии без LLM |
| `npm run e2e:verify -- --manifest <path> --suite live-smoke` | `ux-e2e verify` | Явный настоящий provider smoke |

Это проектируемые команды, не утверждение об их наличии сейчас. Existing input/ask/transcript и web/text surfaces сохраняются, но разрешают session только через manifest. Bootstrap со старым host-dependent поведением удаляется; старые аргументы получают migration error с новой командой, не fallback. Проверка build harness автоматизирована скриптами, но не пересобирает уже закреплённый artifact прогона.

`packages/e2e/scenarios/isolated-smoke.env.json` — будущий committed пример входного manifest без секретов; рядом конкретные isolation/live-smoke/resume рецепты. Дополнительные настройки не требуют редактирования исходников. Вывод по умолчанию короткий: status, manifest, evidence, next command; полный trace хранится отдельно. В JSON режиме stdout содержит только JSON, прогресс идёт в stderr с redaction.

### 2. Входная конфигурация и resolved manifest

Версионируемый input config указывает runtime source как локально установленный `omp` на момент prepare (без абсолютного host пути в committed примере), package source roots, fixture source, scenario, model/role selection, explicit plugin set, auth mode и имена secret environment variables, timeout/retention. Поддерживается небольшой явный набор полей, не произвольный passthrough host config. Prepare определяет realpath/version/digest установленного runtime и применяет compatibility probe; повторный prepare того же run с другой установленной сборкой возвращает конфликт.

Resolved manifest содержит schema, run id, config digest, runtime digest/version/platform, artifact inventory/hash, fixture/scenario digest, roots, sanitized model/auth selection и lifecycle status. Mutable session records отдельно содержат session id, process identity/start marker, log paths и readiness receipts. Bearer терминала и auth secrets в manifest не сохраняются; приватные подключения хранятся отдельно с ограниченными правами и не экспортируются.

Lifecycle: `preparing -> ready -> running -> stopped -> finalized -> cleaned`; ошибка сохраняет диагностический статус и доступ к cleanup. У одного run не более одной активной сессии. Идемпотентный prepare сверяет digest; несовпадающий вход требует нового run id. Атомарная публикация manifest только после подготовки, per-run lock исключает два concurrent prepare/start. Незавершённая подготовка не выглядит готовой.

### 3. Снимок артефактов вместо ссылок

Структура:

```text
cache/<digest>/runtime + packaged dependency closure
runs/<run-id>/manifest.json
runs/<run-id>/home/
runs/<run-id>/workspace/
runs/<run-id>/tmp/
runs/<run-id>/private/
evidence/<run-id>/<session-id>/
```

Кэш публикуется атомарно по content hash, с проверкой целостности перед использованием. На prepare выбирается текущая локальная установка omp, после проверки снимается автономный executable либо его полное необходимое package closure; ссылка на глобальный изменяемый launcher недопустима. В manifest сохраняется фактически используемый абсолютный путь в кэше. Изменение локальной установки после prepare не меняет текущий run и не заставляет его повторно брать runtime с PATH.

Core/fullstack строятся из согласованного staged snapshot входов, включая незакоммиченные изменения, а не многократным чтением изменяемого checkout во время упаковки. Использовать существующие build/package manifests; собрать архивы с тем же shipped file set, что реальная поставка. Закрыть unpublished peer dependencies явно из закреплённого совместимого runtime/dependency set. Не допускать неявного скачивания другой версии core/fullstack или глобального npm prefix. Lifecycle scripts исполняются только в staging/test roots и не получают host `INIT_CWD`/`OMP_PROJECT_DIR`.

Все import/resource paths разрешаются внутри snapshot/runtime closure. Symlinks за его пределы отвергаются; hardlinks к изменяемому checkout не применяются. Общими остаются только неизменяемые артефакты: если runtime ожидает писать рядом с package, такой участок материализуется отдельно для run. Модификация checkout после prepare не влияет даже на поздние импорты и новые sessions.

Альтернатива `npm link` дешевле в подготовке, но не даёт стабильной сборки и затрагивает global prefix; исключена. Переустановка runtime при каждом сценарии дороже и не улучшает изоляцию state; исключена.

### 4. Controlled launch и runtime adapter

Внутренний versioned runtime adapter в e2e отвечает за argv, путь home/agent/config roots, discovery controls, session/log roots и native сигналы о командах. Compatibility определяется возможностями реально установленного на prepare executable и его digest, а не жёстко заданным runtime path или обещанием совместимости любой версии. Неподдерживаемый runtime получает `unsupported_runtime`, а не best-effort launch.

Child env собирается из allowlist базовых системных переменных плюс выбранный auth transport; `HOME`, применимые XDG roots, temporary directories, package-manager prefix/cache и поддерживаемые omp-specific roots задаются явно внутри run. Не наследуются произвольные OMP/PI extension/config/daemon/worktree pointers, `NODE_OPTIONS`, module search paths и shell startup injection. Разрешённые executables выбираются предсказуемо; это защита от штатного смешивания, не запрет произвольного shell.

Workspace — самостоятельная fixture-копия вне developer checkout и его родительского discovery, без ссылок на host `.omp`, `.claude` или plugin registries. Вместо полного user overlay — проверяемые scenario settings; extension paths за declared roots отклоняются. Включены только declared extensions и необходимые discovery providers. Проверяются entrypoints и sibling ресурсы.

Readiness перед LLM-сценарием подтверждается совокупностью контролируемых roots, хешей snapshot, native списка доступных команд и process-level контрольных сценариев с различимыми маркерами двух сборок и загрязняющей host fixture. Проверки запускаются реальным omp в отдельном окружении без LLM; они устанавливают наблюдаемую изоляцию, но не претендуют на полный native readback происхождения каждого загруженного sibling-ресурса. Невозможность отличить заявленный снимок от host plugin либо получить необходимые наблюдения блокирует сценарий. Исходники omp/OpenSpec не меняются.

### 5. Авторизация через штатный broker без копирования профиля

Режимы: `api-key-env`, внешний `broker`, явный `native-host-broker` и provider-free `none`. В режиме `native-host-broker` committed config выбирает `openai-codex` либо `xai-oauth`, соответствующий provider в модели, loopback bind и `start_local: true`. Prepare закрепляет fingerprint эффективного host auth profile, но не запускает процесс и не читает credentials. По явному opt-in doctor/start/live-smoke запускает **прикреплённый к run snapshot executable** с native `auth-broker serve` над текущей host auth DB. Один broker-manager на профиль, вне отдельных runs: повторные прогоны переиспользуют совпадающий живой процесс по private ownership receipt, а чужой слушатель порта не присваивают.

Брокер использует host HOME/profile/agent DB; PTY продолжает получать только run-owned HOME, agent/config/cache и переменные `OMP_AUTH_BROKER_URL`/`OMP_AUTH_BROKER_TOKEN`. Нативный broker создаёт или использует host `auth-broker.token` с mode 0600; harness читает его непосредственно с проверкой owner/type/mode, не выполняет `omp token`, `login`, `migrate` либо `--regenerate`, не копирует host DB и не экспортирует bearer в argv/manifest/report. Клиентский кэш остаётся в run roots и удаляется при cleanup. Broker получает только минимальный host env для выбора того же профиля, не тестовый env.

Штатный broker владеет refresh своих клиентов, однако независимый обычный omp, читающий ту же локальную DB, может конкурировать за refresh. Это осознанный операторский opt-in, **не доказательство single-flight между broker и сторонними процессами**: readiness/receipt фиксируют границу и риск, а приёмка refresh ownership остаётся незакрытой без контролируемого сценария. У broker bearer широкий доступ к credentials профиля; shell внутри тестового процесса не является OS sandbox. Общие provider quotas/billing не изолируются. Локальный broker может менять host auth DB при штатном refresh, но не плагины/config/workflow state. Неуспех native health/auth/provider запроса не допускает fallback на рабочий профиль или mock.

Обычный run cleanup не завершает общий broker и не удаляет host broker token; отдельная команда manager-stop допускается только после проверки независимого process receipt и отсутствия активных клиентов harness. Внешний broker никогда не останавливается этой командой. `broker` извне требует explicit URL/token env; `api-key-env` передаёт только selected variables. Для `none` harness создаёт локальный offline catalog (`auth: none`, недоступный loopback endpoint) и запрещает provider request, без фиктивного ключа.

Контролируемая приёмка refresh ownership выполняется отдельно от `live-smoke`: `oauth-refresh` использует синтетический OAuth-провайдер с локальным token endpoint и временной SQLite DB. Настоящие `AuthStorage`, native broker, client и credential store берутся из явно закреплённой тестовой зависимости `@oh-my-pi/pi-ai`; подменяется только refresh callback через штатную точку внедрения. Это native component/process integration, не проверка неизменённого CLI `auth-broker serve`, не настоящий xAI/OpenAI provider smoke и не свидетельство межпроцессного single-flight обычного omp. Установленный runtime, реальные профили и provider allowlist не меняются.

Сценарий сначала подтверждает использование действующего synthetic access token без refresh, затем переводит только синтетическую запись в окно обновления через native store API. Это учитывает штатный refresh skew 60 секунд без ожидания реального expiry и без подмены глобальных часов. Несколько независимых broker clients одновременно запрашивают авторизацию при удерживаемом ответе локального endpoint: ожидаются один refresh, использование нового access token всеми клиентами, сохранение результата и повторное использование после открытия DB заново. Ошибка token endpoint должна оставаться отказом, не fallback на старый токен; temporary DB, процессы и listeners очищаются. Несекретный receipt сообщает фактическую версию native package, счётчики и границы проверки. Отсутствие совместимого Bun/native dependency — ненулевой отказ, не пропуск теста.

### 6. Session lifecycle, evidence и cleanup

`startTestSession` принимает resolved run context, а не независимо выводит host paths. Каждая session получает новый каталог evidence; общая workspace/state сохраняется. Transcript предыдущей сессии не обнуляется. Existing detached start, reconnect, idle timeout и owned-process stop сохраняются на новой модели.

Report собирается только из manifest/session records. `newestOmpLog` удаляется. Перед экспортом очищаются известные секретные значения, credential headers/URL query и private session connection metadata. Auth caches/DB вообще не являются evidence. Доступ к live terminal URL остаётся приватным; публичный JSON и report его token не содержат.

Cleanup сначала проверяет realpath containment/ownership, затем подтверждает процессы по session identity и start marker, останавливает своё дерево и удаляет private state. По одному PID или имени процесса kill не выполняется. При сомнении — refusal с диагностикой. После crash тот же manifest позволяет безопасную адресную уборку; внешние broker/рабочие omp не принадлежат run.

По умолчанию после успешного verify сохраняется очищенный report и удаляется временная среда; интерактивный start ничего автоматически не удаляет. Failed verify сохраняет диагностическое evidence, а workspace остаётся только с явным `--keep-failed`; auth caches удаляются в любом случае. Cleanup уже очищенного run идемпотентен, не удаляет evidence. Кэш неизменяемых артефактов не требует очистки после каждого теста; удаление кэша не входит в session stop.

### 7. Проверка без лишних provider-вызовов

`isolation` suite использует реальные процессы/runtime и контролируемые fixtures, без LLM: два разных plugin artifacts одновременно, contaminating host fixture и env, изменение исходного snapshot source после prepare, restart и сохранность state/evidence, crash/cleanup, manifest conflict и tampered cache. Сравниваются защищённые plugin/config trees до/после; естественные рабочие logs и штатные broker credential updates не считаются нарушением.

`live-smoke` отдельно проверяет настоящий запрос выбранной модели с reused auth и зарегистрированную команду тестового плагина. Resume recipe проверяет закрытие/reopen в той же среде, а полноценные lifecycle assertions из `run-lifecycle` подключаются как сценарий без переписывания его engine. Неудача самого workflow отделяется от нарушения изоляции; она не превращается в PASS.

Для ресурсов записываются cold/warm prepare time, cache hit, фактически созданные процессы и размер run-owned данных. Warm prepare не запускает package installation или LLM при тех же verified inputs. Произвольные обещания миллисекунд/мегабайт до измерения не фиксируются. По умолчанию live recipes последовательны; параллельность явно задаётся сценарием.

## Risks / Trade-offs

- Native discovery может читать дополнительные roots → isolated child env и workspace, контрольные сборки/host fixture, runtime command signals и process-level тест с fail-closed при неразличимом результате. Полный список путей загруженных sibling-ресурсов runtime не предоставляет; отчёт не должен утверждать обратное.
- Исходники установленного runtime и выбранный executable могут различаться → snapshot полного closure при prepare, pin digest и проверка запуска именно снимка до использования; обновление установленного omp требует нового run.
- Unpublished peers и lifecycle scripts пакетов → isolated staging и полный dependency closure; отсутствие нужного peer блокирует подготовку, не fallback в global install.
- OAuth refresh может конфликтовать с обычным локальным omp, читающим ту же DB → explicit opt-in, один native broker на E2E-клиентов и честный unverified для независимых host-клиентов; не выполнять миграцию/ротацию host credentials и не приписывать межпроцессный single-flight.
- Broker credential может открывать больше аккаунтов, чем нужно сценарию → использовать native account scoping, если доступен; не обещать provider-level security boundary при её отсутствии. Это не меняет изоляцию плагинов.
- Model output может воспроизвести секрет → raw private outputs не экспортируются без redaction; секреты не подмешиваются в prompts. Полная защита от произвольной эксфильтрации агентом не заявляется.
- Snapshot/storage overhead → shared immutable cache; изменяемые данные только per-run. Docker и отдельная установка на каждый сценарий не нужны.
- Одновременные правки checkout при подготовке → согласованный staged input либо явный конфликт, а не смесь двух сборок.

## Migration Plan

1. Добавить manifest/runtime adapter, packaging и environment lifecycle внутри existing e2e package; проверить установленный на prepare runtime и контролируемый process-level isolation без изменения глобального setup.
2. Перевести bootstrap/start/stop/report и все реальные callers/tests на новый путь; удалить unsafe link/host config/log fallback. Legacy scratch требует нового prepare, не автоматического импорта прежней среды.
3. Добавить root scripts и concrete config/scenario recipes; обновить README/CHANGELOG после live proof. Existing UX transport не заменять.
4. Выполнить isolation suite и отдельный live smoke, сохранив scoped receipts. Нет credentials/runtime — соответствующая live-приёмка остаётся незакрытой, не заменяется unit pass.
5. При проблеме откатить код harness и убрать его собственные run roots; глобальные установки не восстанавливать, поскольку этот change их не меняет. До исправления использовать только прошедшую проверку версию harness, не возвращать небезопасный host-dependent path.

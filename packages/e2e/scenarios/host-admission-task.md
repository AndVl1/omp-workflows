# Ручная E2E-проверка host admission и диагностик

## Цель и границы

Проверить PR #72 / issue #71 на реальном OMP: обычные инструменты доступны
законному host, workflow/CTO/native worker не получают регрессий, а отказ
объясняет причину и безопасное действие без доступа к исходникам.

Это checklist оператора `manual-qa`, НЕ prompt тестируемой модели. Запускай
существующий `ux-e2e` harness без `--scenario` и `--task`; команды и короткие
задачи вводи по шагам через PTY. JSON рядом — каталог этапов и evidence markers,
а не автоматический oracle. Совпадение текста/regex само по себе не доказывает PASS.

Владелец всех scratch-сессий и evidence — один manual-QA оператор. Не менять
production-код, host credentials, глобальные plugins/config или чужие процессы.
Исправления production-кода передавать интеграционному владельцу отдельно.

## Обязательный preflight

1. Зафиксировать commit проверяемой ветки, версии OMP/core/fullstack/internal,
   путь фактически загруженного extension и отсутствие import/startup ошибок.
   Использовать текущую локальную сборку PR, не установленный старый release.
2. Создать новые branch-backed Git scratch roots через существующий bootstrap.
   Не использовать worktree монорепозитория, detached HEAD, прежние CTO state,
   claims, grants или `.work-state/cto/run-lifecycle-01a0bacd`.
   До первого `/do-work` создать исходный Git commit с fixture `package.json`
   и существующим lockfile, сохранить их hashes. Одного `git init` недостаточно
   для DoD, сравнивающего dependency graph с `HEAD`. Не включать в commit
   `.work-state`, session logs, credentials или `node_modules`; не выдавать
   post-worker файлы за исходный baseline.
3. Для основного прогона оставить ровно один workflow owner — fullstack. Не
   наследовать project extension internal из монорепозитория. Scratch role/scope
   mapping должен соответствовать действительно доступным агентам fullstack и
   путям `src/`/`test/`, а не внутреннему `omp-*` mapping другого бандла.
4. В actual OMP main и каждом worker использовать только
   `openai-codex/gpt-6-luna` либо `openai-codex/gpt-5.6-luna`. Проверить доступный
   механизм закрепления модели через актуальный CLI help. Role overlay — не
   доказательство actual model: до первой задачи получить session/model evidence.
   При Sol/Astra остановить только собственную сессию, исключить попытку из
   приёмки и исправить setup до продолжения. Не запускать LLM-задачи без проверки.
5. Сохранить baseline `.work-state` до каждого негативного случая и наблюдать
   реальные tool results/файлы. Не создавать положительные evidence вручную.
6. Для подачи terminal input использовать семантику настоящего Enter (`\r` /
   `pressEnter()`), не считать доставку `\n` выполнением команды. Не отправлять
   следующий шаг, пока предыдущий не завершён или явно не отказал.

Для A2 минимальная существующая fullstack-конфигурация
`<scratch>/.omp/team.config.json`:

```json
{
  "scope_map": [
    {
      "glob": ["**/*.ts", "*.ts"],
      "scope": "frontend",
      "dev_agent": "frontend-developer"
    }
  ]
}
```

Проверить наличие `frontend-developer` в фактическом runtime roster. Bootstrap
может скопировать внутренний scope map монорепозитория: `omp-engine-specialist`
не является публичным fullstack-агентом. Корректировать только конфигурацию
нового scratch до запуска, не scope уже созданного run.

Evidence хранить отдельно для каждой сессии: transcript, session metadata,
безопасные выдержки tool results, снимки terminal surface и файловые oracle.
Не публиковать session URL tokens, capabilities, ownership proofs, credentials
или полный сырой context. Raw evidence может оставаться локальным; публичный
отчёт должен содержать безопасные выдержки и ссылки на локальные файлы.

## Обязательные сценарии

### A1. Обычная сессия без workflow

- В свежей interactive-сессии попросить main вызвать именно `bash` с
  `git status --short --branch`, затем `write` создать `scratch-note.txt` с
  текстом `before`, затем `edit` заменить его на `after`.
- Не разрешать модели обходить отказ через Bun shell в `eval`, другой tool или
  отключение extension. Если она не использует нужный tool — уточнить шаг,
  не считать его выполненным по текстовому обещанию.
- Проверить реальные результаты всех трёх инструментов, Git output и байты
  `scratch-note.txt`. Workflow run не должен создаваться ради этих операций.
- Oracle: инструменты допущены, файл равен `after`, нет общего actor refusal.

### A2. Ordinary workflow и настоящий native worker

- Через зарегистрированный `/do-work --new` дать ограниченную задачу: добавить
  маленькую TypeScript-функцию `sum(a, b)` в `src/sum.ts` и исполняемую проверку
  для положительных и отрицательных чисел. Не менять dependency graph.
- В задании явно потребовать `workflow_prepare` с
  `files: ["src/sum.ts"]`: нужны repo-relative пути файлов, не строка `src`.
  В receipt/state проверить разрешённые `scope: ["frontend"]` и
  `dev_agent: "frontend-developer"`. Пустой scope означает ошибку подготовки,
  а не доказанную регрессию admission; повторять в новом корректном scratch,
  сохраняя evidence исходного отказа.
- Зафиксировать `workflow_prepare` receipt, selected run и claim; выполнить
  штатные этапы профиля до terminal, без ручного продвижения state.
- Требовать хотя бы один настоящий `task` dispatch рабочего агента, его actual
  Luna model, изменения исходника и terminal result. Ответ основного агента
  вместо worker не заменяет этот пункт.
- Oracle: worker пишет в разрешённом scope и возвращает результат без отказа
  из-за отсутствия interactive host identity; controller/claim/dispatch checks
  остаются активными, штатная проверка созданной функции действительно проходит.

### A3. Работа после terminal и чистый restart

- После штатного terminal A2 повторить `bash git status`, `write` и `edit`
  отдельного обычного файла без нового workflow.
- Закрыть сессию штатным `/exit`, проверить завершение PTY/harness. Открыть
  новую сессию того же scratch без прежнего чата, снова проверить actual Luna
  model и повторить обычный `bash`.
- Oracle: terminal history не включает старые workflow gates, новый host не
  наследует stale authority, обычные инструменты работают в обеих сессиях.

### A4. CTO и независимая worker authority

- Создать отдельный нейтральный scratch и проверить actual model/owner.
- Вызвать зарегистрированный `/cto` с одной ограниченной задачей и одним slice:
  добавить маленькую функцию форматирования строки и её исполняемую проверку.
  Использовать штатный team/slice setup; не писать canonical CTO state вручную.
- Зафиксировать receipt, точный CTO run/claim, lead → worker dispatch и actual
  Luna model каждого участника. Сначала дождаться выполнения slice и закрытия wave.
- Отдельно явно попросить завершить resident CTO run после всех workers.
  Закрытая wave/standby сами по себе не означают terminal: не менять эту семантику
  и не записывать terminal state вручную ради прохождения теста.
- Oracle: coordinator получает необходимые разрешения, worker работает только
  в разрешённом scope, выбранный CTO claim не подменяется ordinary selection;
  после terminal обычный host `bash` снова доступен.
- Отдельно в idle scratch передать `task` с неавторизованным CTO slice marker.
  Oracle: marker без точного claim не запускает CTO worker; отказ понятен,
  посторонний run/claim не создан. Синтаксис marker брать из текущего публичного
  контракта, не угадывать. Не использовать marker старого пользовательского run.

### A5. Неполный сторонний bundle

- В отдельном scratch загрузить минимальный JS extension, который вызывает
  публичный `registerTeamWorkflow` с `getSessionController`, но без
  `resolveTrustedToolCallActor`. В этой сессии не загружать fullstack/internal
  поверх fixture. Это реальная загрузка extension в OMP, не вызов тестового hook
  вместо host runtime.
- Зафиксировать startup/load error до первой LLM-задачи. По наблюдаемому error и
  локальным счётчикам fixture проверить отсутствие частично установленных hooks
  и публикации owner. Fixture не должен исправлять регистрацию после ошибки.
- Oracle: виден `workflow_registration:missing_actor_resolver`, имя callback
  `resolveTrustedToolCallActor` и понятное действие для автора bundle; нет
  бессмысленного повторения `trusted host actor unavailable` на каждом tool.
- Отдельно отметить поведение OMP при отказе загрузки extension. Не считать
  продолжение host без не загрузившегося bundle доказательством его безопасности.

### A6. Ошибки resolver на реальном tool surface

Использовать отдельную scratch-only fixture-интеграцию с одним owner, построенную
на публичном API core и настоящем захвате host identity на lifecycle boundary.
Разрешены заранее заданные fault modes; fixture не получает полномочия из model
input и не заменяет native worker transport. Не менять production resolver.

По одному fault mode на независимую сессию/явно зафиксированный fixture setup:

| Fault mode | Ожидаемый результат защищённого write/edit/bash |
|---|---|
| Resolver вернул `undefined` | `actor_unresolved`, объяснение отсутствующего результата/причины |
| Resolver выбросил исключение с уникальным секретом-сентинелом | `actor_resolver_failed`, сентинел отсутствует в admission-сообщении |
| Resolver вернул несовместимый результат | `actor_resolver_invalid_result`, нет исполнения |
| Resolver вернул одновременно `kind: denied` и `actor: worker` | `actor_resolver_invalid_result`, нет worker authority или записи |
| Cwd callback выбросил исключение | `cwd_resolution_failed`, нет fallback к process cwd |
| Подтверждённый отказ identity/profile/worktree | Соответствующий стабильный код и безопасное действие |

- Для каждого случая запросить через реальный model/tool surface одну запись
  уникального sentinel-файла; проверить отказ и отсутствие файла/изменения.
- Коды должны различать причины, сообщение — содержать действие и состав репорта.
- Fixture-result injection доказывает обработку и видимость диагностики, но НЕ
  доказывает реальное распознавание чужой identity официальным adapter. Не
  записывать последнюю строку как live foreign-session isolation PASS без
  отдельного настоящего caller/host boundary evidence.

### A7. Подтверждённый host и чужой/неизвестный context

- На официальном bundle проверить доступный runtime способ получить отдельный
  worker/host context без копирования credentials. Host-поля в аргументах tool
  не считать подменой настоящего callback context.
- Проверить, что утверждение `actor: orchestrator`/`hasUI: true` и совпадение
  session ID без доверенной manager identity не создают полномочия. Проверить
  конфликт profile/worktree, если host transport позволяет его воспроизвести.
- Oracle: защищённая операция не исполняется без независимого действительного
  разрешения; законный native worker из A2/A4 при этом продолжает работать.
- Если host API не позволяет такой контекст через публичный surface, записать
  точный BLOCKED и ограничение API. Можно приложить отдельный integration probe,
  но не выдавать его за live E2E и не обходить границу прямым внутренним hook.

### A8. Recovery выбранного run и сохранность состояния

- В новой real OMP-сессии через `/do-work --new` явно попросить выполнить
  только зарегистрированный `workflow_prepare` с repo-relative `files`,
  затем `workflow_instructions` для получения точного `artifactsDir`.
  Не вызывать `begin`/`advance`/`task`: fault setup должен происходить до первого
  worker. Подтвердить отсутствие workers перед fault setup; отдельно сохранить
  PTY slash input и реальные tool results, не выводить одно из другого.
- Поскольку corruption нельзя получить штатной пользовательской командой,
  разрешена ТОЛЬКО явно помеченная scratch fault injection: сохранить snapshot
  и hash конкретного state, затем повредить его JSON или убрать файл. Не трогать
  tokens/claims и не использовать этот способ для продвижения workflow.
- Попросить реальный host выполнить зависящий от выбранного run `bash`/`write`.
- Oracle: `workflow_state_recovery_required` либо более точный установленный
  recovery-код, а не idle fallback/совет только обновить bundle; tool не исполнен,
  повреждённые байты и claim не изменены, другой run не выбран, workers не
  объявлены завершёнными. Проверять hashes до/после именно отказавшего вызова.
- Scratch с намеренно повреждённым state после evidence больше не использовать
  для positive сценариев. Не выполнять ручную «починку» как часть PASS.

### A9. Internal bundle и граница активации

- Проверить internal отдельно от fullstack, с нейтральной marked fixture,
  воспроизводящей только необходимые workspace markers и локальный extension.
  Не запускать тест в текущем рабочем репозитории.
- В marked interactive-сессии выполнить idle `bash/write/edit` и зафиксировать
  понятную диагностику доступного негативного случая.
- В отдельном unmarked scratch проверить, что project-specific internal не
  устанавливает блокирующие workflow hooks для постороннего проекта.
- Oracle: один owner, нет конфликта fullstack/internal, ordinary tools не
  блокируются неактивным bundle. Не переносить результат на внешний Android
  bundle: его activation boundary проверяется только в его окружении.

## Дополнительные кейсы рабочего flow

### B1. Bugfix с воспроизводимой ошибкой

- До первого input подготовить маленький TS fixture с ошибкой на границе диапазона,
  исполняемой проверкой и исходным Git commit. Один исходный запуск должен показать
  конкретный ошибочный результат; это baseline, не результат будущего worker.
- Через `/do-work --new` описать ошибку и ожидаемое поведение, не подсказывая
  внутреннюю форму артефактов. Использовать выбранный матрицей bugfix workflow.
- Oracle: настоящий worker исправляет причину, граничная и обычная проверки
  проходят, producer artifacts соответствуют объявленным schema, run завершается.

### B2. Продолжение без старого чата

- В отдельном обычном workflow дойти до штатного пользовательского checkpoint,
  без активных workers сохранить evidence и завершить собственную сессию.
- Запустить новую Luna-сессию того же scratch и вызвать registered resume с
  точным selector из receipt. Ответить на checkpoint через настоящий ask.
- Oracle: task/classification/run id и уже принятые artifacts сохраняются,
  выполненные этапы не исполняются повторно, новый native worker работает под
  актуальной authority, workflow доходит до terminal. Не создавать human proof
  или canonical state вручную.

### B3. Устанавливаемые пакеты вне checkout

- После сборки установить реальные package tarballs либо опубликованные версии
  core/fullstack в новый scratch без symlink на исходный checkout.
- Зафиксировать версии и фактические пути загрузки, запустить OMP на Luna с одним
  owner. Проверить idle tools и bounded ordinary workflow с настоящим worker.
- Oracle: используются упакованные новые contracts/agents/commands; workflow
  доходит до terminal без чтения незапакованных исходников монорепозитория.
  Локальная установка не является доказательством публикации registry: её
  доступность и команды обновления проверяются отдельно.

## Ограничение исходного Android-репорта

Если установленный `omp-workflows-vk-android@0.4.5`, его исходники или OMP 18.4.2
недоступны, записать отдельный BLOCKED для исходного сочетания. Не менять версию
OMP глобально ради теста. PASS текущего core/fullstack/internal не означает, что
внешний Android bundle уже обновлён или issue #71 можно закрыть целиком.

## Отчёт и завершение

- Для каждого A1–A9 и B1–B3: PASS / FAIL / BLOCKED, точные выполненные шаги, версия/model,
  команды, наблюдаемый результат, evidence paths и независимый файловый oracle.
  Непройденный setup не считать продуктовым PASS или FAIL без диагностики причины.
- Отдельно перечислить настоящие live E2E, fixture-интеграции и дополнительные
  probes. Не заменять manual прогон запуском unit-suite или обещанием модели.
- Для каждого дефекта: воспроизведение, expected/actual, severity и влияние на
  пользователя. Сообщить интеграционному владельцу; не исправлять product code.
- Оставшиеся обязательные BLOCKED означают неполную приёмку, а не общий PASS.
- Сначала сохранить evidence/report, затем закрыть свои сессии `/exit` либо
  `ux-e2e stop <scratch>`. Не использовать `pkill/killall` или чужие PIDs.
  Удалить свои временные wrapper/fixture extensions, не трогая evidence.
  Сохранять raw `session.json` и transcripts локально даже при наличии tokens:
  исключать их из Git/публичного отчёта, а не удалять. Если `stop` сообщил dead PTY,
  отдельно проверить завершение собственного harness wrapper; не считать это
  доказанным только по отсутствию PTY.

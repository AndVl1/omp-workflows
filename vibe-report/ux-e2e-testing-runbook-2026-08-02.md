# Runbook: UX E2E-тестирование omp + omp-workflows (packages/e2e)

**Ветка:** `feat/ux-e2e-test-framework` · **Дата:** 2026-08-02 · **Версия фреймворка:** `@andvl1/omp-workflows-e2e` 0.1.4+

Как тестировать omp и плагин omp-workflows «глазами человека»: фреймворк поднимает реальный omp (PTY) в scratch-проекте, агент-тестировщик (или человек) водит воркфлоу как пользователь — печатает `/do-work`, отвечает на `[ask_user]`, оценивает каждый шаг, ищет дефекты, анализирует вывод тестируемого агента и логи — и получает `manual_qa`-совместимый отчёт.

Этот runbook основан на реальных прогонах (см. `vibe-report/ux-e2e-reference*-ux-e2e-2026-08-02.md`; эталонный PASS-прогон — `ux-e2e-reference3`). Проверенные команды и воркараунды помечены как таковые.

---

## 1. Предусловия

| Что | Требование | Проверка |
|---|---|---|
| omp | v17.2+ (проверено 17.2.3) | `omp --version` |
| Node | >= 22 (используется `Promise.withResolvers`) | `node --version` |
| node-pty | native-пребилд darwin-arm64/linux | `node -e "import('node-pty').then(p=>console.log('ok'))"` — если падает: `npm rebuild node-pty --build-from-source` в `packages/e2e` |
| Модель | **обязательна** LLM-модель в host-конфиге `~/.omp/agent/config.yml` (`modelRoles`); без неё omp грузится в «No model selected» и `/do-work` не запускает агентские стадии | `grep modelRoles ~/.omp/agent/config.yml` |
| Браузер (web-surface) | опционально: `playwright` в devDeps пакета (lazy-импорт). Без него — text-surface | — |
| Патч прав | scratch-проект и `.work-state` пишутся под текущим юзером | — |

> **Про модели (проверено).** Фреймворк запускает omp **без `--profile`**: модели/креды наследуются из host-профиля (`~/.omp/agent/`), а изоляция сессии — через `--session-dir <scratch>/.omp/agent` + два `--config`-оверлея: сначала host-конфиг, потом `.omp/ux-e2e-overlay.json`. Если host-конфиг недоступен/без `modelRoles` — в stderr пишется WARNING, путь записывается в `session.json#host_config`.

---

## 2. Быстрый старт (6 команд)

```bash
cd /Users/a.vladislavov/projects/oss/omp-workflows-monorepo

# 1. Сборка
npm run build -w @andvl1/omp-workflows-e2e

# 2. Scratch-проект (git init + ветка + npm link плагина + .omp/commands + team.config + overlay)
node packages/e2e/dist/cli.js bootstrap my-feature feat/my-feature --monorepo . --workdir /tmp

# 3. Сессия (печатает URL с single-use токеном)
#    ВАЖНО: используйте --scenario (разворачивает {{...}}), НЕ --task <файл>
node packages/e2e/dist/cli.js start /tmp/omp-ux-e2e-my-feature \
  --scenario packages/e2e/scenarios/full-feature.json

# 4. Ответы на [ask_user] (когда появились)
node packages/e2e/dist/cli.js ask /tmp/omp-ux-e2e-my-feature --list
node packages/e2e/dist/cli.js ask /tmp/omp-ux-e2e-my-feature "1"

# 5. Транскрипт сессии
node packages/e2e/dist/cli.js transcript /tmp/omp-ux-e2e-my-feature --tail 40

# 6. Отчёт (JSON + markdown в vibe-report/)
node packages/e2e/dist/cli.js report /tmp/omp-ux-e2e-my-feature \
  --steps steps.json --copy-evidence
```

Корневой шорткат: `npm run e2e -- <subcommand> …` (сначала собирает).

---

## 3. Полный цикл тестирования (по шагам)

### 3.1 Bootstrap — scratch-проект

```bash
node packages/e2e/dist/cli.js bootstrap <slug> <branch> \
  [--workdir /tmp] [--monorepo <путь-к-монорепо>] [--omp <binary>] [--force]
```

Что делает (проверено):
- создаёт `<workdir>/omp-ux-e2e-<slug>`, `git init` + `git checkout -b <branch>` (удовлетворяет gate `branch_created`);
- ставит плагин через **`npm link`** монорепо-пакетов `core` + `fullstack` (НЕ `file:` — неопубликованный peer `@oh-my-pi/pi-coding-agent` дал бы ETARGET);
- материализует `.omp/commands/*` (11 команд: do-work, team, team-next, team-yolo, init-team, …) через `copy-commands.mjs`;
- копирует `.omp/team.config.json` из монорепо (если есть; иначе дефолты);
- пишет `.omp/ux-e2e-overlay.json`: `{ask:{timeout:0}, terminal:{showProgress:true}, autolearn:{enabled:false}, startup:{setupWizard:false}}`.

**Проверка после bootstrap:**
```bash
ls /tmp/omp-ux-e2e-<slug>/.omp/commands/do-work/index.ts   # должен существовать
cat /tmp/omp-ux-e2e-<slug>/.omp/ux-e2e-overlay.json
```

### 3.2 Start — сессия

```bash
# Foreground (рекомендуется для длинных прогонов — живой цикл [ask_user]-подсказок)
node packages/e2e/dist/cli.js start /tmp/omp-ux-e2e-<slug> \
  --scenario packages/e2e/scenarios/full-feature.json \
  [--surface web|text] [--cols 120] [--rows 40] [--max-time 90m] [--idle-ms 3600000]

# Detached (для agent-browser: печатает URL и выходит)
node packages/e2e/dist/cli.js start /tmp/omp-ux-e2e-<slug> \
  --scenario packages/e2e/scenarios/full-feature.json --detach
```

Что печатается: `url` (localhost, single-use токен в query) и `transcript` path.

**Проверки после старта:**
```bash
cat /tmp/omp-ux-e2e-<slug>/.work-state/ux-e2e/session.json   # pid, omp_version, tty, host_config, task_prompt
tail -20 /tmp/omp-ux-e2e-<slug>/.work-state/ux-e2e/transcript.jsonl
```

**Известные грабли (проверено в прогонах):**
- ⚠️ **`--detach` и таймаут шелла (FD-DETACH-LIFECYCLE, MEDIUM).** Если родительский процесс умирает от SIGTERM (таймаут шелла/CI), detached-ребёнок тоже умирает (process group на macOS). Для длинных прогонов запускайте **foreground под супервизором** (nohup, hub.start) или держите `--detach` только для коротких проверок. Останавливать: `ux-e2e stop <scratch>`.
- ⚠️ **Rate-limit при быстрой печати (FD-RL, MEDIUM).** Лимит: **200 входящих фреймов/с на соединение**. puppeteer-дефолт ~30ms/char на длинной промпте пересекает окно → `{t:'err',code:'rate-limited'}` → WS закрыт → **сессия умерла** (single-PTY lifecycle). Воркараунды: (а) `ux-e2e ask <scratch> "<ответ>"` — одним фреймом; (б) `delay ≥ 150–200ms` на символ; (в) слать весь промпт одним WS-фреймом. **Не поднимать лимит** без пересмотра single-PTY следствий.
- ⚠️ **Single-PTY lifecycle.** Одна PTY на сессию; любой дисконнект WS (reload браузера, sleep/resume) убивает omp. Токен single-use — переподключения нет. Планируйте устойчивость через `--max-time` + свежий `ux-e2e start`, если прогон переживает reload браузера.
- **`--task <файл>` НЕ разворачивает `{{...}}`** (читается verbatim; разворачивание — только через `--scenario`, где `loadScenario` подставляет `{{slug}} {{branch}} {{task}} {{cols}} {{rows}} {{max_time}} {{feature_description}} {{project_name}} {{platform_scope}}` + params сценария). Если нужен кастомный промпт с подстановкой — соберите свой scenario-файл (см. §7).

### 3.3 Drive — водим как человек

**Web-surface (основной путь; agent-browser или Playwright):**
1. Открыть URL в браузере (токен в URL — никому не показывать).
2. Дождаться mount xterm (статус `connected`; canvas — текст читается из транскрипта, НЕ из DOM).
3. Напечатать в терминал: `/do-work <task>` (или просто `/do-work` → omp сам предложит демо-задачу в picker'е).
4. На каждый `[ask_user]`-блок: оценить UX вопроса, ответить как владелец продукта (стрелки/Enter в терминале, или `ux-e2e ask <scratch> "<ответ>"`).
5. После каждой стадии: скриншот + запись оценки в `steps.json`.

**Text-surface (fallback без браузера):**
```bash
node packages/e2e/dist/cli.js start <scratch> --surface text
# чтение: node packages/e2e/dist/cli.js transcript <scratch> --tail 200 --follow
# ввод:   node packages/e2e/dist/cli.js ask <scratch> "текст ответа"
```
⚠️ В text-режиме `screenshot()` бросает ошибку by design; ANSI/спиннеры не видны — UX-оценка ограничена.

**Типовая последовательность наблюдений (эталонный прогон reference3):**
| Момент | Что смотреть | Скриншот |
|---|---|---|
| Boot | welcome, модель в статусбаре (`⬢ DeepSeek V4 Flash (New) · ◒ high`), НЕТ «No model selected» | `03-boot-clean-input.webp` |
| `/do-work` | интерактивный picker с вариантами (демо-задача (Recommended) / ввести вручную / отмена / Other) | `04-do-work-picker.webp` |
| clarify | табированный Ask-picker (в прогоне: Стек | Набор настроек | Хранение | Поверхность), описания опций, `❯` highlight, ⌨-хинты | `05`, `06` |
| implementation | todo-лист с прогрессом (I. Implementation 0/4…), инлайн-правила (ts-no-tiny-functions), вывод сборки | `07`, `08` |
| code_review | суб-агент `⟦code-reviewer⟧` в панели subagents, результат ревью | `09`, `10` |
| review_fixes | диффы правок, повторная проверка (FOUC-фикс), коммит | `11`, `12`, `13` |
| summary | recap, idle-состояние | `14` |

### 3.4 Evaluate — оценка каждого шага

Для каждого шага в `steps.json` (структура — см. §6) заполняются **6 измерений по 1–5**:

| Измерение | Что проверять | 1 (сломано) | 3 (приемлемо) | 5 (образцово) |
|---|---|---|---|---|
| `message_clarity` | Название стадии есть? Совпадает с профилем? Терминология консистентна? | нет заголовка/не та стадия | заголовок + интент | заголовок + что производит + что делать юзеру |
| `feedback_timing` | Спиннер/стриминг, нет «мёртвого воздуха», переходы видны | >30s тишины без индикации | спиннер есть, переходы видны | прогресс + elapsed + подсказка следующего шага |
| `error_handling` | Ошибки с причиной + следующим шагом; gate-блокировки показаны; ре-спавн виден | ошибка невидима / тихий стоп / сырой JSON | текст ошибки с причиной | ошибка + точный фикс + авто-ретрай |
| `layout` | Порядок заголовков, выравнивание таблиц, нет переполнения на TTY-ширине, нет дублей | битые ANSI/mojibake/наложение | чистая markdown-отрисовка | консистентная иерархия во всех стадиях |
| `interactivity` | Checkpoint-промпт в нужный момент, опции полные, ответ записан верно, нет dead-end | dead-end / промпт не появился / неверный ответ | промпт с опциями, ответ записан | опции с (Recommended), ответ эхом, follow-up |
| `visual_rendering` | Контраст, unicode-символы, маркеры `[x]`, нет мерцания | fg=bg / мусорные символы | читаемо | тема-консистентно, осознанные цвета |

**Defect floors (движок отчёта сам зажимает оценки):** CRITICAL→кап 1, HIGH→2, MEDIUM→3, LOW→4; без дефектов→5. Средний балл шага = среднее 6 измерений после капа. Общий = среднее шагов.

**Таксономия дефектов:**
- **CRITICAL** — блокирует человека или портит состояние: dead-end AskUserQuestion; зависший терминал; нечитаемый вывод (битые ANSI); стадия «сделана» без видимого результата; записанный ответ ≠ выбранный; коррупция state/артефактов.
- **HIGH** — существенно ухудшает: >30s мёртвой тишины; неверные цвета (fg=bg); mojibake; усечённые до потери смысла опции; пропущенный/задвоенный checkpoint; gate-блокировка без причины.
- **MEDIUM** — заметно, но косметически: непоследовательные маркеры (`[x]` vs `[~]`), кривые таблицы, многословие, редкие символы, медленный рендер большого вывода.
- **LOW** — нитпики: стилистика, лишние пустые строки, пунктуация.

**Оценка качества тестируемого агента** (`agent_quality`): `task_fidelity`, `clarification_quality`, `code_quality`, `verification_rigor`, `tool_use`, `transparency` (каждая 1–5) + общий `rating` + `rationale` (что именно наблюдалось; в эталоне — 5/5 с развёрнутым обоснованием).

### 3.5 Analyze — анализ вывода и логов тестируемого агента

Три источника evidence, все собираются в отчёт автоматически:

| Источник | Путь | Что искать |
|---|---|---|
| Транскрипт | `<scratch>/.work-state/ux-e2e/transcript.jsonl` (NDJSON `{t:'o'|'i',d,at}`) | полный поток: ввод тестировщика + вывод omp; стадии, [ask_user], ошибки |
| omp-лог | `~/.omp/logs/omp.<date>.<pid>.log` (JSON-строки) | boot: провайдеры моделей, MCP-загрузки (в эталоне: figma 401 — ожидаемое env-ограничение; context7/deepwiki OK), TTSR-правила, ошибки |
| Сессия агента | `<scratch>/.omp/agent/sessions/**/session.jsonl` + `<scratch>/.work-state/features/<slug>/observability/events.jsonl` | вызовы инструментов тестируемого агента, события воркфлоу |

Скриншоты — визуальный канал (web-surface); текст всегда из транскрипта (xterm рендерит в canvas).

### 3.6 Stop + Report

```bash
node packages/e2e/dist/cli.js stop <scratch>          # SIGTERM->SIGKILL дерева
node packages/e2e/dist/cli.js report <scratch> \
  --steps steps.json --md-dir vibe-report --copy-evidence
```

Результат: `<scratch>/.work-state/ux-e2e/report.json` + `vibe-report/<slug>-ux-e2e-<дата>.md` (+ копия evidence в `vibe-report/evidence/<slug>/` при `--copy-evidence`).

---

## 4. Verdict-правила (что считается PASS)

- **PASS** — фреймворк отработал end-to-end (bootstrap → start → drive → ответы на [ask_user] → stop → report) без CRITICAL-дефектов фреймворка, И наблюдали UX тестируемого omp/плагина вживую: ≥1 оценка на стадию + ≥1 скриншот с реальным содержимым терминала.
- **CONDITIONAL** — фреймворк работает, но окружение ограничило (нет модели/API-ключей, нет браузера) или есть HIGH-дефекты; покрытие задокументировано.
- **FAIL** — фреймворк сам блокирует: краш, WS не коннектится, ask-детекция сломана, в отчёте нет обязательных полей.

⚠️ **Движок (`artifacts-schema.json#manual_qa`) понимает только `PASS|FAIL`**: неизвестный вердикт (в т.ч. `CONDITIONAL`) трактуется как FAIL в гейтах. В артефакт `manual_qa.json` пишите `PASS|FAIL`; `CONDITIONAL` — только во внутреннем ux-e2e-отчёте, с пояснением.

---

## 5. Артефакты и evidence

Обязательные поля (ручной QA-артефакт, `.work-state/artifacts/manual_qa.json`):
```jsonc
{
  "verdict": "PASS" | "FAIL",
  "mode": "ui" | "runtime",
  "evidence": ["<путь к скриншоту> + ЧТО на нём видно", "<лог-строка>", "<выдержка транскрипта>"],
  "dod_additions": [/* UI-критерии приёма, добавленные в dod.json */],
  "regressions": []
}
```

Структура ux-e2e-отчёта (`report.json`, schema_version 1) — см. `packages/e2e/README.md#Report schema`. Ключевое: top-level `verdict/evidence/mode/regressions` совместимы с `manual_qa`, остальное — аддитивные поля (`session`, `steps[]`, `defects[]`, `agent_quality`, `overall`).

`steps.json` (вход для `ux-e2e report --steps`) — массив шагов:
```jsonc
[
  {
    "id": "stage-clarify", "name": "Clarify stage",
    "order": 5,
    "ratings": { "message_clarity": 5, "feedback_timing": 5, "error_handling": 5,
                 "layout": 5, "interactivity": 5, "visual_rendering": 5 },
    "defects": ["D1"],
    "screenshots": [".../05-clarify-picker.webp"],
    "transcript_excerpt": "Clarify stage fired 4 questions in a 4-tab Ask picker..."
  }
]
```
Плюс top-level `defects[]`, `agent_quality`, `verdict`, `overall`, `regressions` (см. `.work-state/artifacts/ux-e2e-reference3/steps.json` как эталон).

---

## 6. Сценарии как данные

Сценарий = JSON (данные, не код). Новый сценарий = новый файл, ноль правок движка.

```jsonc
{
  "id": "full-feature",
  "task": { "file": "full-feature-task.md" },          // или строка
  "params": { "slug": "my-feature", "branch": "feat/my-feature",
              "task": "implement the feature described in the task prompt" },
  "stages": [
    { "id": "discovery", "name": "Discovery", "expect": ["Discovery", "stage: discovery"] },
    { "id": "clarify", "name": "Clarification", "expect": ["Clarif", "ask_user"],
      "ask_user": [{ "answer": "scoped to the requested surface; keep it minimal", "count": 6 }] },
    { "id": "architecture", "name": "Architecture", "expect": ["Architect"],
      "ask_user": [{ "titlePattern": "architecture", "answer": "1", "count": 1 }] }
    // ... implementation, code_review, review_fixes, manual_qa, qa_tests, summary
  ],
  "timing": { "startupTimeoutMs": 120000, "stageTimeoutMs": 600000, "checkpointPollMs": 2000 },
  "screenshots": { "on": ["stage_start", "ask_user", "error"] },
  "ratings": { "dimensions": ["message_clarity", "feedback_timing", "error_handling",
                              "layout", "interactivity", "visual_rendering"], "min": 1, "max": 5 }
}
```

- `expect` — regex'ы; стадия считается пройденной, когда все совпали с транскриптом.
- `ask_user[].count` — ожидаемое число появлений (clarify — 6, architecture — 1).
- Встроенные подстановки: `{{slug}} {{branch}} {{task}} {{cols}} {{rows}} {{max_time}} {{feature_description}} {{project_name}} {{platform_scope}}`; приоритет: params вызова > params сценария > BUILTIN_DEFAULTS.
- Эталонный промпт (`full-feature-task.md`) намеренно недоопределён (открытые параметры: платформа, глубина скоупа), чтобы clarify-стадия реально стреляла вопросами. Для конкретной фичи — замените `{{feature_description}}`/`{{project_name}}`/`{{platform_scope}}` через params.

---

## 7. Чек-лист эталонного прогона (full-feature)

Скопировать в `vibe-report/<slug>-e2e-scenario.md` перед прогоном; отмечать `[x]` после каждого шага (персистентность к компактизации).

- [ ] `npm run build -w @andvl1/omp-workflows-e2e` — tsc green
- [ ] `node packages/e2e/dist/cli.js --help` — 6 подкоманд
- [ ] `node -e "import('node-pty')..."` — ok (иначе rebuild)
- [ ] bootstrap: scratch-проект создан, `.omp/commands/do-work/index.ts` существует
- [ ] start (foreground под супервизором), URL + transcript напечатаны
- [ ] boot: в статусбаре модель (НЕ «No model selected»), скриншот
- [ ] `/do-work` → picker, выбор демо-задачи или ручной ввод, скриншот
- [ ] clarify: все вопросы отвечены (в эталоне 4 таба), скриншоты до/после
- [ ] discovery → implementation: todo-лист, прогресс, скриншоты
- [ ] code_review: суб-агент в панели, вердикт ревью, скриншот
- [ ] review_fixes: диффы правок, повторная верификация, коммит, скриншоты
- [ ] summary/recap: финальный вывод, скриншот
- [ ] stop + report --copy-evidence: report.json (manual_qa-поля) + vibe-report/*.md
- [ ] manual_qa.json записан (verdict/evidence/dod_additions/regressions)

---

## 8. Troubleshooting

| Симптом | Причина | Решение |
|---|---|---|
| «Error: No model selected» | host-конфиг без modelRoles или недоступен | проверить `~/.omp/agent/config.yml`; `session.json#host_config` |
| Страница «connecting…» навсегда | `/page.js` 404 (старые сборки) или CSP блокирует | пересобрать (`npm run build -w …e2e`); `curl -I <url>/page.js` → 200 |
| `{t:'err',code:'rate-limited'}` + сессия умерла | быстрая печать > 200 фреймов/с | `ask`-батч, delay ≥ 150–200ms, один фрейм на промпт |
| `--detach` «timed out» / пустой транскрипт | ребёнок умер с родителем (таймаут шелла) | foreground под супервизором; `detach.log` покажет причину |
| Транскрипт пустой, PTY живой | ни один WS-клиент не подключился (PTY пишет только в WS) | открыть URL в браузере или подключить WsDriver |
| В `session.json` сырые `{{...}}` | `--task <файл>` читается verbatim | использовать `--scenario`; кастомный промпт — через собственный scenario |
| Нет скриншотов в text-режиме | `screenshot()` бросает by design | web-surface + playwright |
| Сессия умерла после reload браузера | single-PTY lifecycle + single-use токен | свежий `ux-e2e start`; планировать `--max-time` |

---

## 9. Известные дефекты фреймворка (на момент 0.1.4)

| ID | Severity | Суть | Статус |
|---|---|---|---|
| FD-DETACH-LIFECYCLE | MEDIUM | `--detach`-ребёнок умирает с родителем при SIGTERM (macOS process group) | документирован; воркараунд — супервизор |
| FD-RL | MEDIUM | rate-limit (200 фреймов/с) срабатывает на быстрой печати → смерть сессии | документирован; воркараунды в §3.2 |
| FD-REVIEW-REPORT-LOSS | LOW (не фреймворк) | тестируемый агент свернул manual_qa/qa_tests суб-стадии в свой verification-флоу (покрытие 8/10) | наблюдение; для полного покрытия — сценарий с принудительными стадиями |
| `--task <file>` без подстановки | LOW | verbatim-чтение файла, `{{...}}` не разворачиваются | воркараунд — `--scenario` |

---

## 10. Что смотреть в первую очередь (короткая версия)

1. **Boot:** модель в статусбаре, без «No model selected» — иначе дальше нет смысла.
2. **`/do-work`:** picker отвечает, варианты читаемы.
3. **clarify:** вопросы появляются в нужный момент, опции полные, ответ эхом подтверждается.
4. **Стадии:** заголовки, спиннеры, todo-прогресс, ошибки с причиной.
5. **Суб-агенты:** панель subagents, вердикт ревью виден.
6. **Финал:** recap, чистый git-статус, коммит.
7. **Отчёт:** verdict/evidence/mode/regressions валидны для manual_qa-гейта.

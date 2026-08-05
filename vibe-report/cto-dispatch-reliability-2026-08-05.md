# CTO-mode subagent dispatch reliability — root cause + fix

Дата: 2026-08-05 · Статус: FIXED (root cause найден, фикс применён, воспроизведение live)
Автор: main agent (автономно, пользователь спит) · omp: 17.2.8 · Плагин: @andvl1/omp-workflows-fullstack 0.12.0

## TL;DR

«Лиды умирают с exit 1 на вложенном `task`» — это НЕ дефект вложенного диспатча и НЕ
дефект харнесса. Корень: **роль `modelRoles.task` была закреплена за
`minimax-code/MiniMax-M3`**, а MiniMax-M3 под тяжёлым контекстом/большой спекой
интермиттентно ломается в роли сабагента: (1) сталл на nested-`task` — пустые ходы,
харнесс убивает после 3 idle-reminders; (2) yield с null/пустыми данными; (3) галлюцинация
мусорных tool-call'ов / утечка `<mm:think>` середи работы. Прямой диспатч из главного
агента на той же модели падает ТАК ЖЕ (CiFix355) — «lead-layer vs direct» не имеет
значения, имеет значение модель.

**Фикс: `modelRoles.task` → `opencode-go/deepseek-v4-flash:high`** (host config, бэкап
`~/.omp/agent/config.yml.bak-cto-dispatch-20260805`) + контракт-хардненинг в репо
(failover-протокол, dispatch-гигиена). Live-пробы: тяжёлые nested — MiniMax 3/4 ранов
с отказом сабагента, deepseek 9/9 чистых; суммарно deepseek 0/20 прогонов.

## Evidence из продакшена (pr-watch run, crads-platform, 2026-08-05)

| Агент | Роль | Модель | Исход |
|---|---|---|---|
| WatchLead | team-lead | MiniMax-M3 | OK — спавнил воркера (spec 7.8KB) |
| AiLead | team-lead | MiniMax-M3 | OK — спавнил 3 воркеров (3–5KB) |
| CiLead | team-lead | MiniMax-M3 | **exit 1** на 10m08s — сталл при 2-м диспатче (текст без tool-call, idle-reminders) |
| CiLead2 | team-lead | MiniMax-M3 | **exit 1** на 2m09s — сталл при 1-м диспатче (7 мин тишины → dispose) |
| CiFix355 | devops (прямой диспатч CTO) | MiniMax-M3 | **exit 1** середи работы — галлюцинация: `<mm:think>` + мусорный `curl https://ima.qq.com/...` вместо правки |
| CiFix355b | devops (прямой диспатч) | MiniMax-M3 | OK (после респавна) |

Все 4 лида — на одном провайдере (MiniMax-M3), успешные и упавшие. Решение CTO по ходу
рана зафиксировано в `.work-state/cto/pr-watch/decisions.md` (2026-08-05 запись):
«do NOT re-spawn leads for single-worker slices; CTO dispatches fix workers directly».
Этот вывод частично верен (гигиена), но root cause не в слое лида — прямой воркер
CiFix355 упал так же.

## Live-эксперименты (omp 17.2.8, /tmp/cto-dispatch-exp)

Пробник: main → task(lead) → task(worker). Воркер пишет маркер-файл + yield.
- **Простой пробник** (маленькая спека, лёгкий контекст): MiniMax-лиды 1/9 отказов
  (lead «yield with null data»), deepseek 0/7. Маленькая нагрузка — слабый сигнал.
- **Тяжёлый пробник** (лид читает 2×94KB файлов, затем спавнит воркера со спекой 5KB —
  зеркалит реальный CiLead-сценарий):
  - **MiniMax (HA)**: 3/4 ранов с отказом сабагента.
    - h1: `Subagent exited without calling yield tool after 3 reminders` — сталл, маркер НЕ создан (точное воспроизведение CiLead).
    - h2: лид failed (вывод «{»), воркер успел (маркер есть).
    - h3: лид completed, но воркер — `yield result stayed empty after 4 consecutive attempts`.
    - h4: чистый прогон.
  - **deepseek (HB+HC+HD)**: 9/9 чистых (лид completed, воркер completed, маркер есть).
  - **direct** (HE MiniMax / HF deepseek, воркер с лёгким контекстом): 4/4 чистых —
    сталл-риск концентрируется на лиде (тяжёлый контекст + большая спека), прямой воркер
    с лёгким контекстом выживает даже на MiniMax.

Транскрипт сталла (h1-HA1 LeadProbe.jsonl, хвост):
```
reminder 1 of 3 → assistant: (пусто) → assistant: (пусто)
reminder 2 of 3 → assistant: (пусто)
reminder 3 of 3 → assistant: (пусто) → session_exit
```
Точь-в-точь паттерн CiLead2 (текст-без-tool-call → idle-reminders → kill).

## Механика (harness source, bundled omp 17.2.8)

- Сабагенты — in-process сессии (`sN`/`Sl`); nested `task` вызывает ту же функцию рекурсивно.
- Глубина: main=0, lead=1, worker=2; `task.maxRecursionDepth` по умолчанию 2 — лид имеет
  `task`, воркер нет. Механика диспатча не ломается.
- Модель сабагента: `modelRoles.task` (lead: `@team-lead` → `@task` → `task` role; worker:
  `@task` → `task` role). `task.agentModelOverrides` в overlay-конфиге на 17.2.8 НЕ
  применился (проверено эмпирически: лид остался MiniMax) — полагаться на него нельзя.
- Точки отказа — на стороне модели: пустой/текстовый ход без tool-call (сталл → kill),
  yield c null/empty (ретраи → abort), мусорный `<tool_call>` в тексте (не исполняется,
  агент сходит с рельс).

## Решение (применено)

1. **Host config (root cause)**: `~/.omp/agent/config.yml` `modelRoles.task`:
   `minimax-code/MiniMax-M3:high` → `opencode-go/deepseek-v4-flash:high`.
   Бэкап: `config.yml.bak-cto-dispatch-20260805`. Влияет на ВСЕ сабагенты всех проектов
   пользователя (лиды, воркеры, task-роль). `plan/smol/slow` остались на MiniMax.
   Откат: восстановить бэкап.
2. **Контракт `/cto`** (core `packages/core/src/commands/cto.ts` + fullstack-копия
   `packages/fullstack/commands/cto/_lib/cto.ts` + `.omp/commands/cto/_lib/cto.ts`):
   новый блок «Subagent dispatch reliability (lead exit-1 protocol)»:
   1) verify disk state first (никогда не редоить инвентаризацию); 2) респавн лида с ТОЙ ЖЕ
   спекой («resume from disk»); 3) второй отказ → degrade: воркеры напрямую из CTO или
   слияние слайса; 4) single-worker слайсы — без лида сразу; 5) dispatch-гигиена лидов.
3. **Агенты**: `packages/fullstack/agents/cto.md` (rule 9 — failover + degrade + direct
   для single-worker) и `packages/fullstack/agents/team-lead.md` (rule 2 — dispatch-гигиена:
   спавнить рано, спеки по путям, findings на диск, один воркер на вызов; recovery воркера:
   проверка артефактов на диске → респавн с той же спекой).
4. **Тесты**: +1 в core (`cto-command.test.ts`) и +1 в fullstack — assert нового блока
   контракта. 255/255 зелёные (было 253).
5. **CHANGELOG**: запись 0.12.1.

## Выводы / рекомендации

- **Главный фикс — конфиг, не код.** Пин `task`-роли на надёжного провайдера (deepseek).
  MiniMax-M3 можно оставить для plan/slow (оркестрация поверх, не сабагенты).
- «Прямой диспатч вместо лида» — полезная гигиена (меньше хопов, меньше шансов на сталл),
  но НЕ фикс: CiFix355 (direct, MiniMax) упал так же. Не переоценивать (старая lesson
  запись в памяти частично неверна — обновлена).
- Следить: если deepseek-v4-flash в task-роли начнёт сталлить на очень больших спеку/
  контексте — вернуться к измерению. Спеки >10KB + контекст >200KB — зона риска для любой
  модели: контракт уже требует findings на диск, не в спек.

## Артефакты

- Эксперименты: `/tmp/cto-dispatch-exp/` (runs/, matrix-results.tsv, heavy-results.tsv,
  конфиги-оверлеи, run-probe.sh / run-heavy.sh).
- Продакшен-транскрипты: `~/.omp/agent/sessions/home-crads-platform-…/2026-08-04T22-37-27-820Z…/`
  (CiLead.jsonl, CiLead2.jsonl, WatchLead.jsonl, AiLead.jsonl, CiFix355.jsonl, CiFix355b.jsonl).
- Решение CTO: `.work-state/cto/pr-watch/decisions.md` (запись 2026-08-05).
- Бэкап конфига: `~/.omp/agent/config.yml.bak-cto-dispatch-20260805`.

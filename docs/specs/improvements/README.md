# Workflow Improvements — Implementation-Ready Specification

Результат воркфлоу `spec-preparation` (ветка `improvements`, 2025‑08‑25 … 2026‑08‑26).
Статус: **PASS_IMPLEMENTATION_READY** — все решения финальные, аудит пройден, реализация не начата.

## Что это

Спека улучшения workflow-движка omp-workflows по итогам исследования локальных OMP-сессий:
чрезмерная автономность агентов, фиксированный ростер ролей, игнорирование team config,
спотыкания и повторные запуски субагентов. Исследование и все развилки закрыты; код в этой
спеке **не менялся** — она определяет контракты для будущей реализации.

## Финальные решения (DEC-1…DEC-10)

| Решение | Выбор | Суть |
|---|---|---|
| DEC-1 | D1-C | Неизменяемый hard floor (prod deploy/rollback, деструктивные/необратимые операции, credentials, отмена живого worker'а) + profile gates. Unattended/night mode — identity-bound SandboxGrant без checkpoint'ов: разрешённое dev-валидирование выполняется, floor/prohibited/ambiguous — durable defer и продолжение остальной работы |
| DEC-2 | D2-C | Детерминированный typed-slice planner: один кандидат на ready independent slice, роль из capabilities. Центральные leases: **8 на весь run (включая nested teams), 3 на роль**, manual-QA=1, fan-in owner=1. Переполнение → детерминированные волны без потерь. Overrides последними, только внутри safety bounds |
| DEC-3 | D3-A | Чистый cutover legacy-меток minimal/pragmatic/clean: `LEGACY_TIER_UNSUPPORTED` до планирования. Rubric принадлежит core (8 измерений: scope, risk, reversibility, uncertainty, coupling, blast radius, cost, evidence quality); bundles добавляют только namespaced-измерения без права переопределять core |
| DEC-4 | D4-C | Документированный native/core precedence; неоднозначный canonical ownership — fail closed |
| DEC-5 | D5-A | Один canonical engine; плагины дают namespaced каталоги + hyphen aliases `/do-work-<bundle>`, `/team-<bundle>`, `/cto-<bundle>` |
| DEC-6 | D6-C | Recovery-first: сначала evidence/recovery, replay — один раз и только с trustworthy not_started proof |
| DEC-7 | D7-C | Provenance: человекочитаемый report сохраняется с run + авторитетный компактный redacted state (snapshot + кольцо последних 32 invalidation/fallback событий). Логи — только телеметрия. Только repo-relative пути/stable ID/хэши |
| DEC-8 | D8-C | Выбор bundle: explicit > project .omp config > ровно один совместимый; иначе fail closed с диагностикой |
| DEC-9 | layered | Host queue/tool-call boundaries для steering + авторитетные dispatch states; репозиторий восстанавливается первым, no-proof-no-replay |
| DEC-10 | D10-B | Минимальный versioned manifest: описывает compatibility/catalog/caps/aliases/hash, но не расширяет права |

## Ключевые инварианты (выборочно)

- Heartbeat/TTL ambiguity **никогда** не освобождает потенциально живой lease — нужен authoritative terminal/not_started proof или manual resolution.
- Идентичность плана = formula_version + override/inventory/config/selection/mapping/slice-graph/rubric hashes; после запуска план неизменяем.
- File count — только evidence, никогда прямой множитель слотов; token/time estimates запрещены как вход планирования.
- Resume работает из compact state одного; отсутствующий/устаревший report детерминированно регенерируется.

## План внедрения M0–M5

1. **M0** — контракты, ownership, artifact/grant policy, report-only observability
2. **M1** — config/catalog/claims/CAS диагностика + фундамент provenance
3. **M2** — typed slice planner, wave scheduler, центральные global leases (shadow mode)
4. **M3** — policy, unattended sandbox, legacy-cutover, enablement OMP bundle
5. **M4** — layered steering/beacons/fan-in/recovery
6. **M5** — кросс-слоевая контрактная и регрессионная верификация

## Артефакты

| Файл | Что содержит |
|---|---|
| `spec_requirements_edge_cases.json` | REQ-1..61 + INV/LC/ERR/SEC/COMPAT/EC наборы, r5 |
| `spec_options_decisions.json` | Лог решений: варианты, tradeoffs, 10 финалов, r6 |
| `spec_architecture_tasks-architect.json` | Архитектура: schemas, leases, provenance, rubric, task slices TS-00..23, оракулы, r7 |
| `spec_architecture_tasks-tech-researcher.json` | Adversarial review: блокеры закрыты, verdict PASS, r7 |
| `spec_completeness.json` | Финальный аудит: 61/61 трассируемость, r8 |
| `dod.json` | Definition of Done: 9 критериев приёмки с verify_method |

## Верификация (при реализации)

`npm run typecheck`, `npm run test:core`, `npm run test:fullstack`, `npm run build`
+ поведенческие оракулы из `spec_completeness.json` / `dod.json` (floor asks vs unattended defer,
grant forgery/expiry, nested lease caps, ring32 eviction под CAS/crash, LEGACY_TIER_UNSUPPORTED,
rubric determinism и др.).

## Известные находки процесса (стали контрактами)

- Parent status-ping прерывал in-flight запись здорового worker'а → starvation (VF-1);
- Prompt-only beacons недетерминированы (VF-2);
- Валидный артефакт 144 KB отклонялся как нечитаемый; надёжный путь — spill + restore с SHA-256 (VF-3).

Повторное открытие любого финального решения — только по явному указанию пользователя.

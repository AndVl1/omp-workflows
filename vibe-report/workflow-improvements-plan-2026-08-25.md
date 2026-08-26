# Отчёт: план улучшений CTO / team / do-work workflow (wave spec-preparation)

**Дата:** 2026-08-25
**Статус:** план исследовательской/spec-волны одобрен пользователем; **реализация не выполнялась** — в этой волне не произведено ни одного изменения runtime или исходного кода. Всё описанное ниже — одобренный план будущей интерактивной implementation-волны.

---

## 1. Метаданные

| Поле | Значение |
|---|---|
| Репозиторий | `omp-workflows` monorepo (worktree `improvements-cto`) |
| Branch | `improvements-cto` |
| Session | `01a0391e-88a6-75bd-9b6d-4aee2ca53c26` |
| Classification | `type=SPEC`, `complexity=COMPLEX`, `confidence=HIGH` |
| Autonomous | `false` — будущая реализация обязана проходить declared interactive checkpoints |
| Workflow | `spec-preparation` |
| Verdict | `approved` |
| Approved at | 2026-08-25T15:25:28Z |

Канонический одобренный план: [`.work-state/plans/workflow-improvements.md`](../.work-state/plans/workflow-improvements.md).

---

## 2. Исходные проблемы

Пользователь обозначил чрезмерную автономность оркестрации (CTO/team/do-work) и попросил «обсудить и подготовить план» до любого кода. В ходе исследования подтвердились следующие системные проблемы текущей реализации:

1. **Перегруженный флаг автономности.** Единый булев `classification.autonomous` одновременно участвует и в routing (какой workflow запустить), и в checkpoint authorization (право автоматически проходить пользовательские чекпойнты). Отдельного понятия «completion intent» не существует.
2. **Отсутствие typed stage checkpoints.** `spec-preparation` не объявляет типизированных чекпойнтов стадий; отсутствие поля нельзя считать согласием пользователя.
3. **Фиксированный roster.** Роли стадии материализуются как фиксированный manifest; условная селекция на `Set` стирает информацию о кратности (multiplicity) — невозможно «два analyst, один architect».
4. **Хрупкая dispatch-механика.** Подтверждены untracked orchestrator handoff, позиционная атрибуция результатов consilium-слотов и трактовка pending/background состояния как failure.
5. **Plugin-инфраструктура без namespace.** Команды регистрируются в плоской exact-name map — коллизии зависят от порядка загрузки; host-managed namespace отсутствует. Generic workflow-tool adapter приватен внутри fullstack-бандла и недоступен сторонним плагинам.
6. **Опасности конфигурации.** Project config читается first-existing (`.omp` затем legacy `.claude`) без cross-file merge; roles/flags мерджатся shallow, непустой `scope_map` заменяет default целиком; mapping refresh/readers и cwd/provenance могут расходиться.
7. **Runtime-classification на hard-coded scopes.** Собранный `flags.has_runtime` игнорируется.
8. **Недостаточность prompt-only политик.** Два lead-агента воспроизводили запрещённый микроменеджмент (polling/cadence nudges) даже после явного пользовательского запрета — значит, одного промпта недостаточно, нужен механический запрет.

---

## 3. Подтверждённые findings и их ограничения

Findings, подтверждённые evidence (transcripts воркеров, canonical артефакты, integration review), вместе с честно зафиксированными ограничениями доказательной базы:

| Finding | Статус | Ограничение |
|---|---|---|
| Autonomy bool перегружен routing и checkpoint semantics | подтверждено чтением contract/gates кода | — |
| У `spec-preparation` нет typed stage checkpoints | подтверждено схемой workflow | — |
| Fixed role manifests, Set-based conditionals стирают multiplicity | подтверждено stage builder | — |
| Untracked orchestrator handoff, positional attribution, pending-as-failure | подтверждено session forensics на выборке сессий | выборка ограничена доступными сессиями этой волны |
| Flat exact-name command map, приватный generic workflow-tool adapter | подтверждено plugin-extensibility исследованием | — |
| Config: first-existing load, shallow merge, cwd/provenance риски | подтверждено чтением config chain | конкретный исторический root cause инцидента Kotlin-vs-Rust **не доказан** — требуется targeted runtime trace (effective cwd, writer provenance, config version, mapping hash/source); план сознательно не предполагает причину |
| Hard-coded runtime scopes, игнорирование `flags.has_runtime` | подтверждено классификацией | — |
| Confirmed stalls в основной выборке отсутствуют; актуальные failure-классы: wrong path/worktree, malformed/missing artifact, parent expectation mismatch | подтверждено forensics | отсутствие stalls в выборке ≠ отсутствие класса проблем в целом |
| Provider websocket 1006 incident | отдельный infrastructure incident | успешно восстановлен resume-from-disk; не является team verdict или finding'ом о качестве работы |
| Микроменеджмент двух lead'ов после запрета | подтверждено transcript'ами | обосновывает механический запрет в Phase 1, а не prompt-only политику |

Важное методологическое замечание: Rust team и OMP workflow-plugin team были ошибочно объединены в первом synthesis и затем **разделены** corrective artifact'ом и review amendment — в итоговом плане это два независимых предмета.

---

## 4. Пользовательские решения

Зафиксированные в `decisions.md` волны решения (D-001…D-009), определяющие ход работы:

- **D-001.** Текущая волна неавтономна: сначала исследование и обсуждаемый план; реализация только после одобрения. Автопереход к коду воспроизвёл бы саму исправляемую проблему.
- **D-002.** Реестр команд создаёт worker-агент, а не CTO (strict policy запрещает CTO менять конфигурацию вне `.work-state/`).
- **D-003 / D-004.** Сетевые/provider падения (websocket exit, 1006) перезапускаются через resume-from-disk после проверки surviving artifacts; это resource failure, не team verdict. Повторять prep и уже выданные assignments запрещено.
- **D-005…D-007.** No micromanagement: никаких deadlines, polling/cadence checks; `Still Running` и временное отсутствие артефакта — не failure. Зарегистрированные нарушения двух lead'ов приняты как findings; правило включается upfront в будущие dispatch.
- **D-008.** DoD repair для session-forensics из уже готовых canonical артефактов, без повторных исследований.
- **D-009.** Conditional acceptance итогового плана, ставший ключевыми архитектурными решениями:
  - staged plan одобрен, но **Rust bundle исключён** из implementation scope;
  - команда разработки `omp-workflows` становится **отдельным private bundle сразу**, без временного project-local prompt layer;
  - **ровно один active owner** generic workflow/tools/config;
  - compatibility покрывает **OMP 17.x и 18.x**, отсутствие breaking changes не предполагается — подтверждается version-matrix smokes.
  Открытый в момент D-009 вопрос о границе «engine-only core vs engine + fullstack defaults» закрыт в итоговом плане: core определён как engine-only, fullstack defaults переезжают в fullstack bundle.

Подтверждённый свод решений из summary: разделить completion intent / workflow classification / checkpoint permission; roster каждой стадии — allowed pool с situational multiplicity; механический запрет polling/cadence nudges; сетевые failure перезапускаются через resume-from-disk; core → engine-only boundary; отдельный private OMP bundle; ровно один active owner; OMP `>=17 <19` через version matrix; Rust bundle вне scope.

---

## 5. Scope / Out of scope

### In scope

- Механический no-micromanagement и resume-from-disk contract (seven-step).
- Typed control plane: `completion_intent`, `checkpoint_policy`, `roster_policy`, pending/join identity.
- Единый resumable checkpoint path с hard-human floor.
- Bounded adaptive selection из allowed roster (повтор роли разрешён, quota «по одному каждого» отсутствует).
- Dispatch identity, pending lifecycle, orchestrator child ledger.
- Clean migration workflow profiles и retirement legacy-путей.
- **Engine-only core**: generic engine/state/gates/contracts/profiles/templates + generic command/tool/config adapters в core; Kotlin/Go/frontend/mobile defaults и fullstack model taxonomy — в fullstack bundle.
- Runtime scope/classification API и config provenance/cwd safety.
- **Отдельный private OMP workflow-plugin bundle** для разработки этого монорепозитория (владеет `omp-*` agents/commands/policies).
- **Один active owner** generic `workflow_*` tools / generic registration / config writer; co-load без selector/provenance — fail closed.
- Host compatibility **OMP `>=17 <19`**, проверяемая version-matrix smokes.
- Минимальная observability для доказуемого resume/stall handling.

### Out of scope

- **Rust bundle** и всё Rust-specific (agents/commands/package): Rust был лишь примером возможного будущего project-specific override и в эту implementation plan не входит.
- Product-specific bundles для других репозиториев.
- Production deploy/publish в рамках исследовательской/spec-волны.
- Предположение конкретного root cause Kotlin-vs-Rust case без targeted runtime trace.

---

## 6. Ключевые архитектурные принципы (выделенные)

1. **Private OMP bundle сразу.** Не строится временный prompt-only local layer как целевое состояние: bundle владеет `omp-*` agents/commands/policies этого репозитория, активация — по workspace markers (`packages/core`, `packages/fullstack`, package metadata), а не по расширению `.ts`.
2. **Engine-only core.** Core не содержит доменных ролей/дефолтов; fullstack поведение сохраняется явно через свой bundle preset. Private bundle получает полный generic tool contract без копирования fullstack internals.
3. **Ровно один active owner.** Generic `workflow_*` tools, generic workflow registration и config writer принадлежат одному бандлу; конфликт владельцев отклоняется fail closed.
4. **OMP `>=17 <19` — proven, not assumed.** Матрица: installed floor 17.2.2, поздний представитель 17.x — 17.3.4 (наблюдён в evidence), актуальный последний 18.x на момент реализации. Любая несовместимость выражается явной version capability / peer boundary, а не скрытой веткой по номеру строки.
5. **Интерактивные checkpoints.** План не даёт права автономной реализации: на объявленных стадиях обязательны явные пользовательские решения (см. §8). Completion intent никогда не авторизует checkpoint.

---

## 7. Последовательность approved phases

Канонический порядок из одобренного плана:

1. **Dispatch discipline and typed DoD** — запрет polling/deadlines/nudges в шаблонах; typed per-item DoD sidecar + exact slice marker до capability issue; seven-step resume-from-disk.
2. **Typed control-plane contracts** — `completion_intent`, `checkpoint_policy` (hard-human floor), `roster_policy`, pending state, child-join identity; legacy `autonomous` только как migration input; конфликты fail closed.
3. **Classification and checkpoint path** — разделение routing classification и checkpoint permission; единый engine-owned authorization path для internal `run()` и native tools; durable `pause.kind=user_checkpoint`; запрет обхода hard-human checkpoints.
4. **Dispatch identity, pending lifecycle, child ledger** — стабильные `slot_id`/`task_id`; durable pending с lease/recovery; durable child dispatch/join record; единый completion envelope.
5. **Bounded adaptive roster** — детерминированный selector из allowed pool (`allowed_roles`, bounds, triggers, budget), стабильные `role#N` slots; selection snapshot/freeze; первый cutover — полный roster до dispatch, post-result top-up не входит в первую реализацию.
6. **Profile migration and legacy retirement** — объявить policies во всех профилях, мигрировать persisted states/hashes, затем удалить legacy interpretation `classification.autonomous` и Set-based roster path.
7. **Engine-only core and plugin seams** — перенос fullstack defaults в fullstack bundle; экспорт namespace-aware command helper и generic typed `workflow_*` tool adapter; явные bundle identity/provenance; fail closed при двух owners.
8. **Runtime scope API and config safety** — generic scope→runtime-class API; session/project-cwd-aware config writes; сохранение unknown metadata; malformed JSON → видимый diagnostic вместо silent replacement; provenance-aware mapping invalidation. Precondition: targeted runtime trace исторического Kotlin-vs-Rust case.
9. **Private OMP workflow-plugin bundle** — пул: переиспользуемые роли (`team-lead`, `analyst`, `tech-researcher`, `diagnostics`, `architect`, `qa`, `manual-qa`, `code-reviewer`, `security-tester`, conditional `devops`) + новые `omp-plugin-developer`, `omp-engine-specialist`, `omp-host-integration-specialist`, `omp-package-release-specialist`. Command surface: `omp-workflow-team` и read-only `omp-workflow-team validate`, без shadowing голых `do-work/team/cto`/`omp-model-roles`, пока bundle не выбран единственным active owner. Ownership: engine/gates/durable/config → `omp-engine-specialist` + architect/QA/review/security triggers; fullstack host registration → `omp-plugin-developer` / `omp-host-integration-specialist`; manifests/releases → `omp-package-release-specialist`; один writer на файл/path. Зависимости: Phases 7–8, один owner, host range decision.
10. **OMP 17/18 compatibility matrix** — контракт `>=17 <19`: floor 17.2.2, late 17.x = 17.3.4, latest 18.x по факту. Сценарии: extension load, prefixed command discovery, ACP listing, exact command precedence, agent discovery override, workflow tool registration, session cwd, two worktrees, duplicate owner rejection, typed checkpoint/resume, adaptive roster selection. Одинаковый observable contract на всём диапазоне.
11. **Observability enablers** — completion identity tuple из Phase 4 в events; стабильный command/run index без raw transcripts; явный terminal provider/worker transition как единственное основание для stall/replacement.

Definition of done волны реализации: все фазы через обычный интерактивный workflow с declared checkpoints; каждый caller/profile мигрирован, shim-путей после cutover нет; focused contract tests и реальные OMP smokes; поведение fullstack явно через preset; private bundle — единственный активный workflow owner при включении; Rust bundle/package отсутствует; production publish/deploy — только по отдельному явному поручению.

---

## 8. Интерактивные checkpoints будущей implementation wave

Реализация начинается отдельной волной и обязана запросить у пользователя явные решения на объявленных точках (это не разрешение автономной работы):

1. Инвентаризация hard-human checkpoints и их default policy.
2. Точные roster bounds/budget defaults на профиль.
3. Граница миграции persisted-state для legacy `classification.autonomous`.
4. Имя package и activation marker для private OMP bundle.
5. Вердикт targeted runtime trace по историческому Kotlin-vs-Rust поведению.
6. Конкретная последняя 18.x версия в compatibility matrix.
7. Финальное approve на publish/activation после isolated smokes.

---

## 9. Validation / evidence statement

Что проверено в этой волне:

- Все findings получены из первичных источников: transcripts воркеров, canonical артефакты трёх команд (workflow-design, plugin-extensibility, session-forensics), integration review и его amendment. Ни один пункт плана не опирается на неподтверждённое предположение; спорный causal claim (Kotlin-vs-Rust) явно вынесен в precondition targeted trace, а не принят на веру.
- Ошибочное объединение Rust team и OMP workflow-plugin team в первом synthesis обнаружено и исправлено corrective artifact'ом + review amendment до одобрения.
- DoD каждой стадии проверялся отдельно (включая отдельный repair для session-forensics); provider websocket 1006 обработан resume-from-disk без потери работы.

Что НЕ проверено и не утверждается:

- Ни одна фаза плана не реализована; изменений packages/core, packages/fullstack, шаблонов и конфигураций в этой волне нет. Совместимость `>=17 <19` пока декларирована контрактом, но будет доказана smokes только в implementation wave.
- Настоящий отчёт — фиксация одобренного spec-плана, а не отчёт о внедрении.

---

## 10. Канонические артефакты

| Артефакт | Путь |
|---|---|
| CTO summary | `.work-state/cto/01a0391e-88a6-75bd-9b6d-4aee2ca53c26/summary.md` |
| Discovery | `.work-state/cto/01a0391e-88a6-75bd-9b6d-4aee2ca53c26/cto_discovery.md` |
| Team plan | `.work-state/cto/01a0391e-88a6-75bd-9b6d-4aee2ca53c26/team-plan.md` |
| Architecture | `.work-state/cto/01a0391e-88a6-75bd-9b6d-4aee2ca53c26/architecture.md` |
| Integration review | `.work-state/cto/01a0391e-88a6-75bd-9b6d-4aee2ca53c26/integration-review.md` |
| Decisions | `.work-state/cto/01a0391e-88a6-75bd-9b6d-4aee2ca53c26/decisions.md` |
| **Approved plan (канонический)** | `.work-state/plans/workflow-improvements.md` |
| Recommendation: workflow design | `.work-state/artifacts/workflow-design/recommendation.md` |
| Recommendation: plugin extensibility | `.work-state/artifacts/plugin-extensibility/recommendation.md` |
| Bundle proposal: omp-workflow-team | `.work-state/artifacts/plugin-extensibility/omp-workflow-team.md` |
| Recommendation: session forensics | `.work-state/artifacts/session-forensics/recommendation.md` |
| Настоящий отчёт | `vibe-report/workflow-improvements-plan-2026-08-25.md` |

# Model Roles — фича-отчёт

- Date: 2026-08-02
- Branch: `feat/agent-model-roles`
- Workflow: `/team full-feature` (checkpoints до user handoff, далее автономно)
- Epic (br): `br-agent-model-roles-9dk` (closed — история)
- Supersedes: PR #12 `feat/per-project-agent-overrides` (closed superseded)

## Что сделано

**Проблема**: PR #12 плодил дубли агентов (`.omp/agents/<role>-<model>/*.md` с пропатченным frontmatter). Переделка — завязка на нативные модельные роли OMP.

**Решение** (архитектура pragmatic, выбрана пользователем):
1. **14 кастомных OMP-ролей per класс агента** (имена не конфликтуют с 10 built-in): architect, reviewer, security, coordinator, researcher (tech-researcher+discovery), analyst, developer-go, developer-kotlin, frontend-developer, developer-mobile (+init-mobile), devops, diagnostics, qa, manual-qa.
2. **Frontmatter 17 агентов**: `model: ["@<class-role>", "@<standard-role>"]` — первый резолвящийся паттерн побеждает; роль не задана → литерал не матчится → фоллбэк на `@task`/`@slow`/`@smol`. Всё на нативных механизмах харнесса (`resolveConfiguredRolePattern`/`resolveModelRoleValue`), engine не тронут.
3. **`/omp-model-roles`**: validate (14 ролей vs `modelRoles` юзера, резолв-статус, frontmatter-инварианты, пересечения с built-in, provenance, предупреждения про `task.agentModelOverrides`) + recommendations (промпт главному агенту: `task(tech-researcher)` со строгими JSON-схемами входа/выхода; свежие бенчи через `web_search`; только модели из inventory пользователя; никаких фиксированных таблиц).
4. **Конфигурация**: `modelRoles` в project `.omp/config.yml` (перекрывает глобальный) или глобально; нативное назначение через `/model` (TUI Model Hub, `modelRoleStorage: project|global`); `/switch` — session-only.

## Верификация

- Unit: 44/44 (fullstack), typecheck/build PASS (core + fullstack).
- Manual QA (packages/e2e, omp 17.2.3): verdict **PASS**.
  - Validate-таблица: architect/developer-go class-resolved из project `modelRoles`; 12 ролей — fallback на `@task`/`@slow`/`@smol`.
  - Live-спавн: субагенты `ImplScratchDemo` (developer-kotlin) и `ReviewScratchDemo` (code-reviewer) заспавнились на `minimax-code/MiniMax-M3` через фоллбэк-цепочки; родительская сессия модель не меняла (subagent-side резолв).
  - Non-mutation: md5 project `.omp/config.yml` стабилен.
  - Отчёт: `vibe-report/model-roles-ux-e2e-2026-08-02.md`.
- Code review: 2 HIGH + 3 MEDIUM → исправлены, ре-ревью approve; остатки LOW (D1/D2, bun-skip) не блокеры.

## Для пользователя

- В своих проектах: `.omp/config.yml` → `modelRoles: { architect: "<provider>/<model>:<thinking>", ... }` — или через `/model` (TUI Hub).
- `task.agentModelOverrides` (code-reviewer: minimax, qa: minimax в глобальном конфиге) приоритетнее ролей — после перехода на роли их можно удалить.
- Полный e2e-сценарий фичи: `packages/e2e/scenarios/model-roles.json` (+ `model-roles-task.md`).

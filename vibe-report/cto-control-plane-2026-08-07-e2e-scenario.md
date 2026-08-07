# CTO Durable Control-Plane — E2E Scenario

Slug: cto-control-plane-2026-08-07 · Дата: 2026-08-07 · Платформы: Backend, Web

Источник правды для финальной проверки. Перед каждым validation action перечитать этот файл; выполненные `[x]` не повторять. При ошибке зафиксировать результат и оставить шаг `[ ]`.

## Подготовка

- [x] Проверить доступные package scripts и deploy tooling: репозиторий содержит build/typecheck/test/e2e scripts, отдельного production deploy script или production URL нет.
- [x] Спросить платформы через AskUserQuestion: выбраны Backend и Web.
- [x] Выполнить `playwright-cli list` с именованными сессиями.
- [x] Проверить все открытые browser sessions: `omp-askuser-ux` указывает на `http://127.0.0.1:18082/` cc-proxy DEV, не на CTO control-plane production surface; не переиспользовать.
- [ ] Получить production URL и deploy command для этого plugin-source репозитория.
- [ ] Выполнить обязательный production deploy через проектный скрипт и дождаться health check.

## Backend

- [x] Core typecheck: `cd packages/core && npx tsc --noEmit` — exit 0.
- [x] Fullstack typecheck: `cd packages/fullstack && npx tsc --noEmit` — exit 0.
- [x] Core focused tests: `node --test --import tsx test/cto-engine.test.ts` — 89/89 pass.
- [x] Core safety tests: redaction + outbox-gate — 15/15 pass.
- [x] Fullstack adapter tests: `node --test --import tsx test/adapters.test.ts` — 36/36 pass.
- [x] Scheduler daemon focused test: `node --test --import tsx test/cto-scheduler-daemon.test.ts` — 2/2 pass.
- [ ] Production backend smoke: health endpoint plus mock/escalation round-trip and quarantine behavior.

## Web

- [ ] Open the production web surface in the approved named `playwright-cli` session.
- [ ] Exercise the CTO control-plane flow through the Web UI.
- [ ] Confirm rendered state/terminal output and capture screenshot evidence.
- [x] Local fallback (non-production): `playwright-cli` drove `/cto` on `packages/e2e` loopback surface with real CR submit; xterm internal buffer rendered the CTO prompt and working spinner.
- [x] Local fallback screenshot: `.work-state/artifacts/integration/evidence/cto-local-mock-surface.png`; harness, scratch directory, browser session, and PTY cleaned.
- [x] Architecture-required local mock surface was exercised and labeled non-production; it does not close the production-only steps above.

## Acceptance

- [x] Integration review revision 2: APPROVED; INT-1/2/3 resolved; 142 focused tests pass.
- [ ] Production deploy and Backend smoke complete.
- [ ] Web visual flow complete.

## Blocker

As of 2026-08-07 the repo is a plugin source monorepo, not a deployed web service. No production deploy script, production URL, or health endpoint is present in repository files. The selected production-only Backend/Web checks cannot be honestly marked complete without that external deployment target.

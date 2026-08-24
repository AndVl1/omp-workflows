# Spec-preparation → full-feature handoff E2E scenario

Slug: spec-handoff-full-feature · validation target: `ccproxydev.andvl.pro` only

Источник правды для manual-QA. Перед каждым validation action перечитать этот файл; выполненные `[x]` не повторять. При ошибке зафиксировать результат рядом со шагом и оставить невыполненные шаги `[ ]`.

## Preparation / remote gate

- [x] Inspect project scripts and reachability for dev deploy + health gate; no `scripts/deploy.sh` or equivalent deploy script exists, and `curl -I -L --max-time 20 https://ccproxydev.andvl.pro` returned HTTP/1.1 200 (HTML).
- [x] Deploy fixed code to dev with the project deploy script if available; no deploy script is present, so no agent deployment was possible. Remote health/reachability gate is recorded above; remote code freshness remains unproven.
- [x] Run `playwright-cli list -s=spec-handoff-full-feature` (exit 0) and inspect all existing open sessions. `cc-proxy-local-sync` is at `https://ccproxydev.andvl.pro/login`; other open sessions are unrelated (`127.0.0.1:8765`, `https://crads.ru/start`).
- [x] Reuse the existing named session `cc-proxy-local-sync` at `https://ccproxydev.andvl.pro/login`; initial snapshot shows `CC Proxy`, `Login with Telegram`, and `Log in with Telegram`. No new session opened.

## Handoff flow on dev

- [ ] Locate or complete an implementation-ready spec in the spec-preparation workflow — **BLOCKED on dev**: the session is unauthenticated at `/login`.
- [ ] Approve the implementation-ready spec; capture visible status/capability state — **BLOCKED on dev**: Telegram OAuth is required and no authenticated project surface is available.
- [ ] Invoke `workflow_handoff` from terminal `spec-preparation` to target `full-feature`; **NOT OBSERVED on dev** because auth/gate blocked entry.
- [ ] Confirm `workflow_status` transitions to `full-feature` at `discovery` and capture target capability/provenance — **NOT OBSERVED on dev**.
- [ ] Proceed to development dispatch from the fresh target capability; **NOT OBSERVED on dev**.
- [ ] Verify the old source capability/cursor is rejected after handoff — **NOT OBSERVED on dev**.
- [ ] Verify the fresh target capability authorizes the next development stage/dispatch — **NOT OBSERVED on dev**.
- [x] Capture blocker evidence: `cc-proxy-local-sync` snapshot at `https://ccproxydev.andvl.pro/login` showed `CC Proxy`, `Login with Telegram`, and `Log in with Telegram`; click opened Telegram OAuth tab `https://oauth.telegram.org/auth?...`; screenshot `../../../../projects/private/cc-proxy/.playwright-cli/page-2026-08-24T11-16-44-403Z.png`; snapshot reported `Console: 127 errors, 0 warnings`.

## Deterministic fallback if dev is unreachable

- [x] Run deterministic local fixtures (all exit 0): `node --test --import tsx --test-name-pattern='fullstack: workflow_handoff delegates to the engine and returns the one-time target envelope' packages/fullstack/test/workflow-tools.test.ts` → 1 pass/0 fail; `node --test --import tsx --test-name-pattern='handoff: success preserves source state and arms the target discovery stage with a fresh capability' packages/core/test/handoff.test.ts` → 1 pass/0 fail; `node --test --import tsx --test-name-pattern='handoff: synthetic route transfers into a dispatchable single target stage; gates accept the fresh epoch and reject the old one' packages/core/test/handoff.test.ts` → 1 pass/0 fail. Observed assertions cover typed approval/public handoff, target `full-feature`/`discovery`, fresh dispatch marker acceptance, and old source epoch rejection.
- [x] Keep remote dev criteria blocked: `https://ccproxydev.andvl.pro` is reachable (HTTP 200) but only exposes unauthenticated Telegram login; no project deploy script exists, so fixed-code deployment and authenticated handoff transition cannot be observed.

## Closeout

- [x] Write `.work-state/features/fixes/artifacts/debug.json` with `verdict: PASS`, `iterations: 1`, exact matched-build/local handoff/replay/runtime-guard command results, honest unauthenticated remote limitation, and retained screenshot path.
- [x] Update `dod.json` only for the directly observed local `repro-after` contract; leave remote-only `manual-qa-e2e` and unsupported criteria pending.
- [x] Cleanup decision recorded: `cc-proxy-local-sync` predated this run and was not closed; no new session was started, so closing the existing user/other-agent session was intentionally avoided.

---
name: custom-agent-bundle
description: Add your own agents on top of omp-workflows-core — build a custom dev bundle (Rust/Go/mobile), agent frontmatter, model-role taxonomy, registerTeamWorkflow roles/scopeMap/flags, custom slash commands, before_agent_start hooks. Use when the user asks to create custom agents, add a new agent set, build a custom bundle/workflow plugin, write a /rust-model-roles-style command, or wire new agents into /do-work.
---

# Custom Agent Bundle — adding your own agents

Проверено на `@andvl1/omp-workflows-fullstack` и omp 17.2.x.
Полный runnable пример с project-local marker, activation owner и registry
transaction находится в [`docs/adding-agents.md`](../../../../docs/adding-agents.md#4-регистрация-workflow).

## 1. Discovery и frontmatter

OMP ищет агентов в project `.omp/agents`, user `~/.omp/agent/agents`, затем
extension package `agents/`; проектный агент с тем же `name` переопределяет
extension-агента. Bundle должен включать `agents/` и `skills/` в `package.json#files`.

Минимальный frontmatter:

```markdown
---
name: developer-rust
model: ["@rust-developer", "@task"]
description: Rust developer - implements Rust code.
tools: read, write, edit, glob, grep, bash
---
# Rust Developer
Implement code following the approved plan.
```

`model` — ordered role chain; `thinkingLevel`, `spawns`, `blocking`, `prewalk`,
`autoloadSkills`, `output` и `readSummarize` — optional. Таксономия `ModelRoleEntry`
и helpers (`resolveRoleChain`, `isResearchRequest`, `isResearchResponse`) приходят
из core; bundle владеет собственными role names и fallback chains.

## 2. Marker-bound workflow registration

Не используйте ownerless `registerTeamWorkflow`. Bundle bootstrap явно пишет
физический project-local marker (например `.omp/rust.activation.json`) точными
байтами; npm install, extension loading и `session_start` marker не создают и
глобальную установку не выполняют. `WorkflowOwnerIdentity.activation.required`
должен ссылаться на этот marker (с digest точных байт, если он опубликован).

Один owner factory и один session-aware `resolveCwd` передаются во все три seams:

- `registerTeamWorkflow(..., { owner, resolveCwd, registrationToken })`;
- `createWorkflowToolAdapter({ owner, resolveCwd, registrationToken })`;
- `registerWorkflowCommands({ owner, resolveCwd })`.

До записи profiles/gates/config откройте marker activation через
`openWorkflowActivation`, начните registry transaction с capability scope
`["workflow_profiles", "constitution_gate", "runtime_config", "workflow_tools"]`, передайте только
opaque `transaction.token`, затем commit/rollback. Используйте
`closeWorkflowActivation` для cleanup; raw owner claim/release/close helpers,
owner id и marker strings вместо token запрещены. Несовпадение marker/root,
owner conflict или отсутствие cwd должны fail closed.

Полная схема с resolver, owner descriptor, explicit bootstrap и lifecycle — в
[`docs/adding-agents.md`](../../../../docs/adding-agents.md#4-регистрация-workflow).

## 3. Slash commands и coexistence

```typescript
registerWorkflowCommands(pi, {
  commandPrefix: "rust",
  resolveCwd: resolveSessionCwd,
  owner: ownerForCwd,
});
```

Это публикует namespaced commands. Registered extension commands имеют приоритет
над legacy `.omp/commands` copies; копирование запускается только explicit CLI,
без postinstall и без session-start writes.

## 4. Проверка

Focused smoke должен проверить: exact marker path/digest, canonical root,
activation owner, transaction capability scope, token-bound registration,
commit/rollback и ровно выбранную command surface. Project-wide build и full
suite запускает release/QA owner.

## 5. Скелет

```
omp-workflows-custom/
├── package.json          # omp.extensions + files: dist, agents, skills
├── src/
│   ├── index.ts          # activation + one registry transaction
│   └── activation-marker.ts # exact marker bytes/digest
├── agents/
├── skills/
└── workflows/
```

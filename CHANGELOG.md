# Changelog

All notable changes to NanoClaw will be documented in this file.

## Unreleased

- **feat:** Add local agent runtime (`AGENT_RUNTIME=local`) — run agents as local child processes without Docker
  - New `src/local-runner.ts` with same interface as `runContainerAgent()`
  - Agent-runner workspace paths now configurable via `NANOCLAW_WORKSPACE_*` environment variables (backward-compatible, defaults to `/workspace/*`)
  - Runtime dispatch in `src/index.ts` and `src/task-scheduler.ts`
- **feat:** Add interactive CLI chat (`npm run chat`) — talk to the agent directly in terminal without channels or Docker
  - `scripts/local-chat.ts` supports interactive multi-turn mode and single-shot mode
  - Single long-lived agent-runner process with IPC-based follow-up messages
- **feat:** Add `AGENT_RUNTIME` config option (`'docker' | 'local'`) to `src/config.ts`

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)

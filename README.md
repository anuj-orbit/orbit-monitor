# orbit-monitor: Mission Control

A live dashboard for the Orbit AI Dev Team (Hermes #2). For every task it shows:
- the stage
- the agent flow graph (Manager → planner/leaders → workers/reviewers)
- models and cost
- logs

It also lists the history of finished tasks.

```
Hermes #2 container ──(shared volume, read-only use)──> collector sidecar ──> MongoDB (orbit_monitor) <── this web app
   state.db (sessions, messages, costs)
   devteam/events.jsonl (stages, written by track.mjs)
```

## Parts

| Path | Runs where | What |
|---|---|---|
| `collector/collector.mjs` | Sidecar container in the Hermes_DevTeam Coolify service (`node:22-alpine`), Hermes volume at `/hermes` | Every 5 s: syncs Hermes sessions → `agents`, tool calls → `logs`, `delegate_task` calls → `delegations` (route/role per sub-agent), stage events → `tasks`, OpenRouter key usage → `state`. Redacts secrets. Reconstructs pre-tracking runs as "untracked" tasks |
| `src/` + `public/` | Coolify app `mission-control` (this repo, Dockerfile) | Basic-auth API + single-page UI. Overview: live task, totals, spend by tier, task list. Task page: stage stepper, budget bar, flow graph, agents, cost by model, logs filterable per agent |

## Config (env vars on the web app)

| Var | Meaning |
|---|---|
| `MONGODB_URI` | `orbit_monitor` database URI (internal host) |
| `MC_USER`, `MC_PASS` | Basic-auth login for the UI and API (`/health` stays public) |

The collector reads `MONGO_URI` from `/hermes/devteam/collector.env`, and the OpenRouter key from Hermes's `.env`. It uses the `mongodb` driver already installed at `/hermes/tools/node_modules`.

## Develop

```bash
npm ci && npm run lint && npm test
MONGODB_URI=... MC_USER=u MC_PASS=p npm start
```
CI: lint + tests → Docker build → Coolify deploy, the same as `anuj-orbit/app-template`.

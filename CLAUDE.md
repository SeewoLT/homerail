# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run install:all      # Install all package dependencies
npm run build            # Build all packages
npm test                 # Build + run all package tests + live validator tests
npm run typecheck        # TypeScript type-check all packages
npm run ci               # typecheck + build + test (CI pipeline)
npm run ci:local         # Run Linux CI jobs locally via act
npm run audit            # npm audit across all packages (high severity+)
```

### Per-package commands (run from package directory or via --prefix)

```bash
npm test                 # vitest run (all packages use vitest)
npm run test -- --run src/foo.test.ts  # Single test file
npm run typecheck        # tsc --noEmit
npm run build            # tsc
```

agent-ui extras:
```bash
npm run dev              # Vite dev server
npm run lint             # ESLint
npm run e2e              # Playwright E2E
npm run test:coverage    # vitest with coverage
```

### CLI at runtime

```bash
hr start                 # Start Manager + Node services
hr doctor                # Check system readiness
hr run <template>        # Run a DAG template
hr dag supervise <id>    # Watch a running DAG
hr scorecard <id>        # Show DAG run scorecard
hr eval-run <id>         # Evaluate a completed run
hr model configure       # Set up a model provider
hr templates list        # List DAG templates
hr patterns list         # List DAG patterns
hr smoke dag             # End-to-end smoke test
```

## Project Structure

**TypeScript monorepo** (Node 20+, npm 10+) with 7 packages, each using `tsc` for builds and `vitest` for tests. No build orchestrator — scripts in root `package.json` iterate over packages directly.

### Package dependency order (build order)
`homerail_protocol` → `homerail_plugin_sdk` → `homerail_manager` / `homerail_node` / `homerail_worker` / `homerail_cli` → `agent-ui`

### Packages

| Package | Role |
|---------|------|
| `homerail_protocol` | Shared contracts, types, Zod schemas, validation — single source of truth for runtime communication. No runtime deps on other packages. |
| `homerail_plugin_sdk` | Declarative plugin dev kit. HRP package codec, scaffold, codegen. Depends on protocol. |
| `homerail_manager` | Manager service — DAG coordinator, voice surface, generative UI, SQLite persistence, WebSocket control plane. Depends on protocol + plugin_sdk. |
| `homerail_node` | Node service — provisions Docker Worker containers for each DAG node. Depends on protocol. |
| `homerail_worker` | Worker runtime — harness adapters for Claude Agent SDK / Kimi Code SDK. Runs inside Docker. Depends on protocol. |
| `homerail_cli` | The `hr` CLI (commander-based). Start/stop services, run/inspect DAGs, manage config. Depends on protocol + plugin_sdk. |
| `agent-ui` | Vue 3 + Vite browser UI. Renders voice surface, DAG visualizations, generative UI widgets. Depends on protocol. |

### Architecture

Three-tier runtime: **Manager** (DAG coordinator, runs as local service) → **Node** (provisions Docker containers) → **Worker** (agent harness per DAG node, runs inside container). Workers for one run share `${HOMERAIL_HOME}/workspace/<run_id>/`.

- DAGs are YAML templates in `assets/orchestrations/` — describe nodes, edges, handoff contracts
- Each DAG node runs in its own context with isolated workspace, using potentially different models per node
- Persistent state: Manager uses better-sqlite3 for sessions, runs, scorecards, plugin distribution
- Control plane: WebSocket between Manager ↔ Node ↔ Worker

### Key directories

```
assets/orchestrations/   — DAG template YAML files
docs/                    — Architecture docs, specs, patterns
scripts/                 — Live validator tests, CI helpers, deployment scripts
skills/                  — Reusable agent instructions (SKILL.md format)
plugins/builtin/         — Built-in plugins (pr-closeout, topic-outline, core-generative-ui)
plugins/examples/        — Example plugin projects
```

### Testing conventions

- **Package tests**: `vitest run` per package, co-located with source (`src/*.test.ts`) or in package-level `tests/`
- **Live validator tests**: Root `scripts/*.test.mjs` — integration-level validators that exercise the full stack (Manager, Node, Worker). Run via `npm run test:live-validator`
- **E2E**: agent-ui has Playwright-based E2E in `agent-ui/scripts/e2e.mjs`
- New tests follow behavior-oriented naming, not implementation-oriented

### Package manager

npm workspaces are NOT used — each package has independent `node_modules`. Install with the root `install:all` script. Local dependencies reference each other via `file:../` paths in package.json.

### Platform notes

- Build and run from Git Bash (or other POSIX shell) on Windows — cmd/PowerShell won't work for scripts
- Docker required for Worker containers
- Default ports: Manager `19191`, Agent UI `19192` (HTTPS), `19193` (HTTP fallback)

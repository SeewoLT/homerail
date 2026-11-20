# Repository Guidelines

## Project Structure & Module Organization
This repo is a TypeScript monorepo. Core packages live in `homerail_protocol/`, `homerail_plugin_sdk/`, `homerail_manager/`, `homerail_node/`, `homerail_worker/`, `homerail_cli/`, and `agent-ui/`. Shared docs live in `docs/`, orchestration assets in `assets/`, automation in `scripts/`, and reusable agent instructions in `skills/`. Keep package-local code, tests, and package metadata inside each package directory.

## Build, Test, and Development Commands
Use the root scripts from `package.json`:

- `npm run install:all` installs dependencies for every package.
- `npm run build` builds all packages.
- `npm test` builds first, then runs package tests and repository-level validator tests.
- `npm run typecheck` runs TypeScript checks across packages.
- `hr start` starts Manager and Node locally; `hr start --ui` also launches the Agent UI.
- `npm run ci:local` runs the local CI workflow for Linux-oriented checks.

On Windows, run CLI-related commands from Git Bash or another POSIX-compatible shell.

## Coding Style & Naming Conventions
Follow the existing TypeScript style in each package. Use clear, descriptive names; prefer `camelCase` for variables and functions, `PascalCase` for types and classes, and lowercase file names that match nearby conventions. Keep changes ASCII by default and follow the package’s current formatting and import order. Do not introduce a new formatter or lint rule unless the package already uses one.

## Testing Guidelines
Tests are split between package-level test scripts and root validator tests under `scripts/`. Name new tests to reflect behavior, not implementation details. When changing orchestration, CLI, or runtime behavior, run the relevant package tests plus `npm test` or at least the affected package command and `npm run typecheck`.

## Commit & Pull Request Guidelines
Recent commits use short imperative subjects with optional scopes, such as `fix(ui): ...`, `chore: ...`, or `feat: ...`. Keep commit messages narrow and action-oriented. Pull requests should explain what changed, why it changed, and how it was verified. Include screenshots or screen recordings for `agent-ui/` changes, and link any related issue or task when available.

## Operational Notes
This project depends on Docker for worker execution and on local `hr` commands for runtime control. If you touch startup or sync behavior, verify both the service path and the UI path on the target platform before merging.

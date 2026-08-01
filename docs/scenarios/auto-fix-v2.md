# Auto Fix v2 operator runbook

Auto Fix v2 is implemented as a separate, opt-in workflow. It does not replace
the existing `auto-fix` trigger.

Local deterministic coverage is green. Before a live pilot, deploy a Manager
release containing this workflow, sync its mixed-model profile, install the
`github-autofix` encrypted credential, and create a dedicated Draft PR for
Issue #172. Do not sync the v2 workflow into an older Manager release that
predates the runtime and broker support described below.

## What is enforced

- `task_document` and `pr_context` are staged as content-addressed Manager
  artifacts and projected read-only below `/workspace/input`.
- K3 analyzes the task. Dynamic DeepSeek V4 Flash implementers receive isolated
  Git worktrees and no GitHub credential.
- The DeepSeek aggregator may read and update only the bound Draft PR through
  the `github_pr` Manager broker.
- GLM-5.2 reviewer nodes have `session_scope: dispatch`; every re-entry gets a
  new provider session and no portable checkpoint/transcript.
- Each rejected review creates one fresh dynamic DeepSeek fixer. Four fix
  rounds plus the initial review give exactly five total review rounds.
- GitHub writes are expected-head, fast-forward-only, non-force, bounded to 64
  files/1 MiB, and restricted by `pr_context.writable_paths`. Workflow files,
  `.git`, and the mounted input directory are always denied.

## GitHub credential

For a pilot, a repository-scoped fine-grained PAT is acceptable. Give it only:

- Contents: read and write
- Pull requests: read-only
- Checks: read-only

Store it as an encrypted Manager credential; it is never placed in a Worker:

```bash
printf '%s' "$GITHUB_AUTOFIX_TOKEN" | hr credential set github-autofix \
  --type api_key --name 'GitHub Auto Fix fine-grained PAT'
```

For production, prefer a GitHub App installed only on the target repositories.
Use Contents read/write, Pull requests read, and Checks read. Store the App
material as an opaque JSON credential with fields `app_id`, `installation_id`,
and `private_key`; the broker mints a short-lived installation token for each
call.

```bash
printf '%s' "$GITHUB_AUTOFIX_APP_JSON" | hr credential set github-autofix \
  --type opaque --name 'GitHub Auto Fix App' --json-stdin
```

Issue comments should use a separate outer-runner credential with Issues
read/write. Do not widen the DAG credential merely to post status comments.

## Immutable PR context

Create `pr-context.json` from the already-created same-repository Draft PR:

```bash
shasum -a 256 /absolute/path/to/task.md
```

Put that digest into `task_document_sha256`; the Manager verifies it against
the actually staged `task_document` before any PR action.

```json
{
  "version": 1,
  "owner": "xiaotianfotos",
  "repo": "homerail",
  "pull_number": 999,
  "clone_url": "https://github.com/xiaotianfotos/homerail.git",
  "head_ref": "autofix/issue-172",
  "base_ref": "main",
  "initial_head_sha": "40-character-head-sha",
  "base_sha": "40-character-base-sha",
  "task_document_sha256": "64-character-sha256-of-task.md",
  "require_draft": true,
  "writable_paths": ["homerail_manager/src", "homerail_manager/tests"]
}
```

The broker refuses a non-Draft PR, a different base/head/branch, an external
head update, a fork/cross-repository PR, a task-document digest mismatch, or a
write outside the path allowlist.

The broker's token permissions are necessary but not the only boundary. The
WorkflowSpec also limits which nodes can call which broker actions, the Worker
transport is fenced to the current lease/session/generation, and `commit_files`
enforces the immutable PR identity, expected head, writable path allowlist,
file/byte limits, and `force: false`.

## Model profile

The stable Manager must contain active Anthropic-compatible settings whose
identities match K3, DeepSeek V4 Flash, and GLM-5.2. Configure the profile with:

```bash
export HOMERAIL_AUTO_FIX_V2_ANALYZER_MODEL='<K3 setting id>'
export HOMERAIL_AUTO_FIX_V2_IMPLEMENTATION_MODEL='<DeepSeek V4 Flash setting id>'
export HOMERAIL_AUTO_FIX_V2_REVIEW_MODEL='<GLM-5.2 setting id>'
node scripts/configure-auto-fix-v2-runtime-profile.mjs
```

The analyzer uses the `kimi-code` harness. DeepSeek and GLM use the
Claude-compatible harness; no coding role uses direct chat-completions.

## Start a local or stable run

```bash
hr run auto-fix-v2 --sync \
  --prompt '{}' \
  --profile auto-fix-v2-mixed \
  --input-scope issue-172-pilot \
  --input-file task_document:input/task.md=/absolute/path/to/task.md \
  --input-file pr_context:input/pr-context.json=/absolute/path/to/pr-context.json
```

The caller supplies only the immutable files and a small bootstrap object. The
task itself is never reconstructed from Agent conversation history.

## Local proof without GitHub or model spend

```bash
npm --prefix homerail_protocol run build
npm --prefix homerail_manager exec vitest run \
  tests/auto-fix-v2-scenario.test.ts \
  tests/github-pr-broker.test.ts \
  tests/run-input-artifacts.test.ts \
  tests/dag-runtime-primitives.test.ts
npm --prefix homerail_node exec vitest run \
  src/storage/__tests__/workspace-inputs.test.ts \
  src/control-plane/__tests__/lifecycle-handler.test.ts
npm --prefix homerail_cli exec vitest run tests/run-inputs.test.ts
node scripts/auto-fix-v2-runtime-profile.test.mjs
```

The fake-remote scenario proves two dynamic implementers, four dynamically
generated fixers, five total reviews with distinct sessions, cold recovery,
read-only input projection, per-node GitHub actions, non-force head fencing,
path denial, task/PR identity binding, fork/closed-PR denial, and
external-head-drift rejection.

This proof does not spend model tokens or mutate GitHub. Before production,
add a trusted required-checks gate: today GLM can read `checks_snapshot`, but
the DAG runtime does not independently prevent an approval handoff when checks
are missing or failing.

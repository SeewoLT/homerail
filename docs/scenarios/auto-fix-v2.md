# Auto Fix v2 operator runbook

Auto Fix v2 is implemented as a separate, opt-in workflow. It does not replace
the existing `auto-fix` trigger.

Local deterministic coverage is green. Before a live pilot, deploy a Manager
release containing this workflow, sync its mixed-model profile, install the
`github-autofix` encrypted credential, and create a dedicated Draft PR for
Issue #172. Do not sync the v2 workflow into an older Manager release that
predates the runtime and broker support described below.

## What is enforced

- `task_document`, `task_plan`, and `pr_context` are staged as content-addressed
  Manager artifacts and projected read-only below `/workspace/input`.
- The trusted caller owns worker decomposition. Dynamic DeepSeek V4 Flash
  implementers receive the validated plan, isolated Git worktrees, and no
  GitHub credential. Their worker policy must explicitly
  declare `{{fanout_workspace}}`; Manager resolves it to the unique child
  worktree, so isolation never creates an implicit write grant.
- The DeepSeek aggregator may read and update only the bound Draft PR through
  the `github_pr` Manager broker.
- GLM-5.2 reviewer nodes have `session_scope: dispatch`; every re-entry gets a
  new provider session and no portable checkpoint/transcript. A rejected
  handoff-contract correction stays in that same logical dispatch so a valid
  same-session `required_checks` receipt remains usable; if the receipt was
  missing, correction mode permits only that declared read-only verification
  call before the final handoff.
- Each rejected review creates one fresh dynamic DeepSeek fixer. Four fix
  rounds plus the initial review give exactly five total review rounds.
- GitHub writes are expected-head, fast-forward-only, non-force, bounded to 64
  files/1 MiB, and restricted by explicit `pr_context.writable_paths` prefixes.
  `writable_paths: ["."]` is invalid; `.github/**`, `.git/**`, and the mounted
  input directory are always denied even when a broader prefix is declared.
- An `approve` handoff is rejected by Manager unless the same fresh reviewer
  dispatch successfully called `github_pr/required_checks` and every immutable
  required check passed on the exact current PR head.

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
  "writable_paths": ["homerail_manager/src", "homerail_manager/tests"],
  "required_checks": ["Core (Linux, Node 24)"]
}
```

The broker refuses a non-Draft PR, a different base/head/branch, an external
head update, a fork/cross-repository PR, a task-document digest mismatch, or a
write outside the path allowlist. `required_checks` contains one to 32 unique,
exact GitHub check-run names. It is immutable for the run; the broker selects
the newest run with each exact name and requires `completed`/`success` on the
current head.

CLI input bindings declare their media type through the immutable mount suffix:
`.md` is Markdown, `.json` is validated JSON, and `.txt` is plain text. The CLI
rejects other suffixes, invalid UTF-8, and invalid JSON before staging.

The broker's token permissions are necessary but not the only boundary. The
WorkflowSpec also limits which nodes can call which broker actions, the Worker
transport is fenced to the current lease/session/generation, and `commit_files`
enforces the immutable PR identity, expected head, writable path allowlist,
file/byte limits, and `force: false`.

This repository's pull-request CI intentionally skips Draft PRs and does not
run on Draft `synchronize` events. Before a reviewer can approve, an operator
or trusted outer automation must manually dispatch CI with the Draft head
branch selected as the workflow ref, then verify that the configured exact
check name appears on that head SHA. The DAG credential remains Checks
read-only and cannot manufacture or override check results.

`commit_files` uses GitHub's bounded Git Data API sequence (blob, tree, commit,
then non-force ref update). A failure before the ref update can leave
unreachable Git objects, but cannot advance the PR. Operators should respect
GitHub rate limits and retry only after re-reading the bound PR head; the broker
reconciles a pending update during recovery.

## Immutable task plan

The Manager Agent or another trusted caller must turn the reviewed task
document into this fixed `task_plan` input before starting the DAG:

```json
{
  "version": 1,
  "task_document_sha256": "64-character-sha256-of-task.md",
  "tasks": [
    {
      "id": "implementation",
      "title": "One parallel-safe implementation unit",
      "description": "Exact scope and implementation direction",
      "files": ["path/to/expected-file.ts"],
      "acceptance": ["Observable focused check"]
    }
  ],
  "shared": {
    "repository_path": "repo",
    "task_document": "input/task.md",
    "task_plan": "input/task-plan.json",
    "pr_context": "input/pr-context.json"
  }
}
```

The command gateway verifies the document digest and the exact shared paths;
the WorkflowSpec contract enforces one to three bounded tasks. Dependent work
must be combined into one item. Because this plan is a content-addressed run
input, dynamic worker count and division cannot drift with Agent conversation
history.

## Model profile

The stable Manager must contain active Anthropic-compatible settings whose
identities match DeepSeek V4 Flash and GLM-5.2. Configure the profile with:

```bash
export HOMERAIL_AUTO_FIX_V2_IMPLEMENTATION_MODEL='<DeepSeek V4 Flash setting id>'
export HOMERAIL_AUTO_FIX_V2_REVIEW_MODEL='<GLM-5.2 setting id>'
node scripts/configure-auto-fix-v2-runtime-profile.mjs
```

DeepSeek and GLM use the Claude Agent SDK harness against their
Anthropic-compatible endpoints; no coding role uses Kimi Code or direct
chat-completions. This keeps `allowed_builtin_tools` enforceable for every Auto
Fix v2 Agent node. An upstream Manager Agent may use any suitable model to
author `task-plan.json`; that planning session is not part of the execution DAG.

Auto Fix v2 intentionally does not configure any node-level or workflow-level
tool-call budget. Do not add a fixed tool-call budget to this workflow.

The caller may supply only one to three parallel-safe implementation items and
must combine coupled work instead of declaring a separate
verification/dependency worker. For every successful worker result, Manager
verifies that `workspace_path` is
the assigned isolated worktree, `commit_sha` exists and is that worktree's
current HEAD, and the worktree is clean before aggregation can start.

## Start a local or stable run

```bash
hr run auto-fix-v2 --sync \
  --prompt '{}' \
  --profile auto-fix-v2-mixed \
  --input-scope issue-172-pilot \
  --input-file task_document:input/task.md=/absolute/path/to/task.md \
  --input-file task_plan:input/task-plan.json=/absolute/path/to/task-plan.json \
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
path denial (including `.github/actions/**`), task/PR identity binding,
fork/closed-PR denial, external-head-drift rejection, and a Manager-enforced
required-checks approval fence that cannot reuse a prior dispatch receipt.

This proof does not spend model tokens or mutate GitHub. A real Draft-PR pilot,
including creation of the configured check run on the exact Draft head, remains
required before production adoption.

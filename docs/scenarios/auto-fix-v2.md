# Auto Fix v2 operator runbook

Auto Fix v2 is implemented as a separate, opt-in workflow. It does not replace
the existing `auto-fix` trigger.

Local deterministic coverage is green. Before a live pilot, deploy a Manager
release containing this workflow, sync its mixed-model profile, install the
`github-autofix` encrypted credential, and create a dedicated Draft PR for a
new low-risk pilot Issue. Do not reuse a failure-evidence PR or sync the v2 workflow into an older Manager release that
predates the runtime and broker support described below.

## What is enforced

- `task_document`, `task_plan`, and `pr_context` are staged as content-addressed
  Manager artifacts and projected read-only below `/workspace/input`.
- The trusted caller owns worker decomposition. Dynamic DeepSeek V4 Flash
  implementers receive the validated plan, isolated Git worktrees, and no
  GitHub credential. Their worker policy must explicitly
  declare `{{fanout_workspace}}`; Manager resolves it to the unique child
  worktree, so isolation never creates an implicit write grant.
- DeepSeek coding roles explicitly select
  `builtin_tool_policy: backend_native`. This is a Codex-only opt-in to the
  native sandboxed shell/patch surface, is mutually exclusive with the exact
  Claude-style `allowed_builtin_tools` field, and requires `workspace_access`.
  HomeRail still verifies that the turn changed only declared paths.
- On Linux Docker Nodes, Manager automatically requests the fixed Codex Worker
  profile only for the `codex_appserver + backend_native` combination. It adds
  no capabilities and does not use privileged containers. Auto Fix v2's
  writable coding roles explicitly select `danger-full-access` for Codex's
  command layer so test subprocesses and loopback listeners behave normally;
  Docker mounts, cgroups, the disposable-container lifecycle, and HomeRail's
  post-turn path verification remain active.
- The Worker image contains an immutable dependency cache for Agent UI and the
  HomeRail protocol, plugin SDK, Manager, Worker, Node, and CLI packages. Before
  a writable Codex dispatch, Worker compares each worktree's dependency-relevant normalized
  `package.json` and `package-lock.json` with the image-owned copies. Matches receive an
  ignored `node_modules` facade made only of links into the image; local
  HomeRail dependencies link back to that dispatch's worktree. A metadata
  mismatch or an unmarked existing dependency tree is not reused. Auto Fix
  prompts require build/typecheck/test to run directly against these projected
  dependencies rather than `npm ci`. Tasks that change package metadata need a future trusted
  dependency-update service outside the model container.
- The DeepSeek aggregator may read and update only the bound Draft PR through
  the `github_pr` Manager broker. `commit_workspace` derives every dirty path
  and byte from the node's single declared writable worktree and publishes one
  commit, so the model cannot omit a file or spend output context on base64.
  Manager rejects every successful Candidate/FixResult unless both `head_sha`
  and `manifest_sha256` match that exact broker result. A `cannot_fix` result
  instead binds `previous_head_sha` to the exact PR snapshot and requires no
  fabricated commit manifest.
- GLM-5.2 reviewer nodes have `session_scope: dispatch`; every re-entry gets a
  new provider session and no portable checkpoint/transcript. A rejected
  handoff-contract correction stays in that same logical dispatch so valid
  same-session broker receipts remain usable. Correction mode retains only the
  hard broker evidence declared for that output port, including prerequisite
  `pull_request_snapshot` and `checks_snapshot` reads; it cannot broaden the
  original capability.
- GLM receives no repository/workers/fixers mount. It reads changed or related
  UTF-8 source only through `read_file` bound to the exact current PR head, so
  local dirty integration state cannot influence the verdict.
- Read-only reviewer containers keep `/workspace` read-only and receive one
  nested writable mount only at `/workspace/.homerail-runtime` for trusted
  Worker audit/session telemetry. This prevents audit writer startup from
  crashing a read-only Worker without granting repository writes.
- Each rejected validation or review creates one fresh dynamic DeepSeek fixer.
  The loop permits at most five candidate evaluations and four fixes. A
  validation failure consumes an evaluation, so the number of GLM dispatches
  may be lower than five.
- GitHub writes are expected-head, fast-forward-only, non-force, bounded to 64
  files/1 MiB, and restricted by explicit `pr_context.writable_paths` prefixes.
  `writable_paths: ["."]` is invalid; `.github/**`, `.git/**`, and the mounted
  input directory are always denied even when a broader prefix is declared.
- Before each GLM dispatch, a Manager-owned `validate_head` broker node requires
  every immutable check on the exact current PR head. Terminal check failures
  become a structured fixer task. For a failed GitHub Actions check, Manager
  also retrieves a bounded, sanitized tail of the matching job log when the
  check app, repository, and job/check ID all match the immutable binding. Log
  content remains repository-controlled, untrusted diagnostic text and is
  explicitly labeled as never-instructions; the token and response headers
  never enter the Worker. Missing/pending checks
  wait until the bounded operational timeout. After `approve`, a separate Manager-owned
  `required_checks` node re-checks the approved `head_sha` before success.
  `github_pr` is the broker implementation name and must never be supplied as
  the credential reference.

## GitHub credential

For a pilot, a repository-scoped fine-grained PAT is acceptable. Give it only:

- Contents: read and write
- Pull requests: read-only
- Checks: read-only

If `pr_context.validation_workflow` is configured, also grant Actions:
read/write so the broker can call `workflow_dispatch` and retrieve failed job
logs. If trusted CI is triggered outside the DAG, Actions: read-only is enough
for the bounded job-log evidence; without it the broker safely falls back to
the check-run output and details URL.

Store it as an encrypted Manager credential; it is never placed in a Worker:

```bash
printf '%s' "$GITHUB_AUTOFIX_TOKEN" | hr credential set github-autofix \
  --type api_key --name 'GitHub Auto Fix fine-grained PAT'
```

For production, prefer a GitHub App installed only on the target repositories.
Use Contents read/write, Pull requests read, and Checks read. Add Actions
read when failed GitHub Actions job logs should be included, or Actions
read/write when the broker also dispatches validation. Store the App material
as an opaque JSON credential with fields `app_id`, `installation_id`, and
`private_key`; the broker mints a short-lived installation token for each call.

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
  "required_checks": ["Core (Linux, Node 24)"],
  "validation_workflow": {
    "workflow_id": "core.yml",
    "inputs": { "head_sha": "$head_sha" }
  }
}
```

The broker refuses a non-Draft PR, a different base/head/branch, an external
head update, a fork/cross-repository PR, a task-document digest mismatch, or a
write outside the path allowlist. `required_checks` contains one to 32 unique,
exact GitHub check-run names. It is immutable for the run; the broker selects
the newest run with each exact name and requires `completed`/`success` on the
current head when trusted outer automation owns validation.
`validation_workflow` is optional. When present, `workflow_id` is a bounded
workflow file/id and `$head_sha` input values are replaced with the exact
candidate SHA. Manager binds the resulting `workflow_dispatch` run to the
configured workflow, exact branch, and exact candidate SHA. The whole run must
complete successfully; a successful required anchor cannot mask a later or
parallel failing matrix job. All required anchors must also exist and succeed
inside that bound run. The post-review finalizer repeats this whole-run check.

CLI input bindings declare their media type through the immutable mount suffix:
`.md` is Markdown, `.json` is validated JSON, and `.txt` is plain text. The CLI
rejects other suffixes, invalid UTF-8, and invalid JSON before staging.

The broker's token permissions are necessary but not the only boundary. The
WorkflowSpec also limits which nodes can call which broker actions, the Worker
transport is fenced to the current lease/session/generation, and
`commit_workspace` enforces the immutable PR identity, exact worktree/head,
complete dirty-file manifest, writable path allowlist, file/byte limits, and
`force: false`.

This repository's pull-request CI intentionally skips Draft PRs and does not
run on Draft `synchronize` events. Configure `validation_workflow` so Manager
can dispatch trusted CI with the Draft head branch and exact SHA input, or have
trusted outer automation create the configured check on that SHA. The broker
can observe results but cannot manufacture or override check conclusions.

`commit_workspace` uses GitHub's bounded Git Data API sequence (blob, tree,
commit, then non-force ref update). A failure before the ref update can leave
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

The stable Manager must contain an active Responses-compatible DeepSeek V4
Flash setting and an active Anthropic-compatible GLM-5.2 setting. Configure the
profile with:

```bash
export HOMERAIL_AUTO_FIX_V2_IMPLEMENTATION_MODEL='<DeepSeek V4 Flash setting id>'
export HOMERAIL_AUTO_FIX_V2_REVIEW_MODEL='<GLM-5.2 setting id>'
node scripts/configure-auto-fix-v2-runtime-profile.mjs
```

DeepSeek implementers, aggregator, and fixers use the Codex app-server harness
against the Responses endpoint with `reasoning_effort: max`. Long multi-minute
reasoning and high tool counts are expected; operators must not treat elapsed
thinking time as a stuck worker. Codex app-server emits a content-free
heartbeat every 30 seconds while its notification stream is silent, and Worker
renews the actor lease with a generic activity without retaining private
reasoning text. The turn ends only on a real completion/error, operator
cancellation, or child-process exit. GLM review uses the Claude Agent SDK
against its Anthropic-compatible endpoint. No coding role uses Kimi Code or
direct chat-completions. An upstream Manager Agent may use any suitable model
to author `task-plan.json`; that planning session is not part of the execution
DAG.

These three writable coding roles explicitly use
`codex_sandbox: danger-full-access`. This disables Codex's inner command
sandbox so repository tests may bind loopback listeners and use synchronous
child processes normally. The permission is still contained by the disposable
Worker container and is rejected for a read-only DAG workspace. Before Codex
starts, Worker removes every HomeRail control-plane token/secret from the child
environment; the GitHub credential is never projected and PR mutation remains
available only through the Manager broker. Do not copy this policy to a Worker
that receives direct credentials or broad host mounts.

Auto Fix v2 intentionally does not configure any node-level or workflow-level
tool-call budget. Do not add a fixed tool-call budget to this workflow.

The caller may supply only one to three parallel-safe implementation items and
must combine coupled work instead of declaring a separate
verification/dependency worker. For every successful worker result, Manager
verifies that `workspace_path` is the assigned isolated worktree, creates the
Git commit itself from the policy-checked file changes, injects the resulting
`commit_sha` into the fan-out result, and verifies that the commit is the clean
worktree HEAD before aggregation can start. Model-issued Git metadata changes
remain disallowed.

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
  tests/dag-gateway.test.ts \
  tests/cold-recovery.test.ts \
  tests/run-input-artifacts.test.ts \
  tests/dag-runtime-primitives.test.ts
npm --prefix homerail_node exec vitest run \
  src/storage/__tests__/workspace-inputs.test.ts \
  src/control-plane/__tests__/lifecycle-handler.test.ts
npm --prefix homerail_worker exec vitest run \
  src/__tests__/prompt-runner.test.ts \
  src/__tests__/codex-appserver.test.ts \
  src/__tests__/codex-working-directory.test.ts
npm --prefix homerail_cli exec vitest run tests/run-inputs.test.ts
node scripts/auto-fix-v2-runtime-profile.test.mjs
```

The fake-remote coverage proves two dynamic implementers, four dynamically
generated fixers, five total reviews with distinct sessions, fifth-round
exhaustion, dormant-loop cold recovery, read-only input projection, Manager
broker action projection, exact-head validation pending-to-success, failed
validation-to-fixer routing, non-force head fencing, path denial (including
`.github/actions/**`), task/PR identity binding, fork/closed-PR denial,
external-head-drift rejection, and an independent final required-checks fence.

This proof does not spend model tokens or mutate GitHub. A real Draft-PR pilot,
including creation of the configured check run on the exact Draft head, remains
required before production adoption.

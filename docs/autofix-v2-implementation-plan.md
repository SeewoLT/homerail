# Auto Fix v2 Implementation Plan

Proposed GitHub Issue title:

> feat(autofix-v2): document-first Draft-PR repair DAG with secure dynamic fan-out

Status: Opt-in MVP implemented and locally verified on 2026-08-01. The real
Draft-PR pilot and production adoption gates remain open. This is the umbrella
delivery plan for [`Auto Fix v2`](architecture/autofix-v2.md); it does not
authorize replacing the existing `auto-fix` workflow or enabling automatic PR
publication.

## Implementation checkpoint (2026-08-01)

Implemented in the MVP:

- content-addressed, immutable run inputs with read-only Worker projection and
  recovery verification;
- fail-closed dynamic worker policy inheritance, unique repeated-fanout node
  ids, and isolated Git worktrees;
- `session_scope: dispatch` for transcript-free review re-entry;
- a Manager-only `github_pr` broker for bounded PR/files/check snapshots and
  expected-head, non-force file commits;
- an opt-in eight-static-node `auto-fix-v2` WorkflowSpec, mixed-model profile
  configurator, CLI input staging, operator runbook, and deterministic fake
  remote/recovery proof.

Required before the first real Issue #172 pilot:

- create the same-repository Draft PR and immutable `pr-context.json`;
- install `github-autofix` as an encrypted fine-grained PAT or GitHub App
  credential;
- verify the stable Manager still has active, runnable K3, DeepSeek V4 Flash,
  and GLM-5.2 settings after deploying the v2-capable release;
- sync the opt-in workflow and mixed-model profile, then run a
  broker-write-disabled real PR snapshot dry run;
- add a trusted validation gateway that prevents approval unless required
  checks for the exact current head are complete and successful. The MVP
  exposes `checks_snapshot` to GLM but does not make that result an
  orchestration-level approval fence.

## Outcome

Deliver a manual `auto-fix-v2` workflow in which:

- a caller stages an immutable local task document and binds it to a Draft PR;
- K3 creates a bounded plan of one to three parallel-safe work items;
- dynamically created DeepSeek V4 Flash implementers work without remote
  credentials in isolated worktrees;
- a DeepSeek V4 Flash aggregator integrates their patches;
- deterministic validation runs before review;
- GLM-5.2 reviews each candidate with a fresh provider context;
- a new DeepSeek V4 Flash fixer handles each rejected round;
- no more than five candidate/review rounds run;
- only the aggregator and fixers can request fast-forward PR writes through a
  least-privilege Manager broker;
- the successful outcome remains a Draft PR marked `ready_for_human` in
  HomeRail, not approved or merged on GitHub.

## Delivery Rules

- Keep `assets/orchestrations/auto-fix.yaml.template` and workflow id
  `auto-fix` unchanged during the pilot.
- Introduce a new workflow id, profile id, scenario documentation, and trigger.
- Keep provider/model names out of WorkflowSpec. Bind active LLM setting ids in
  the runtime profile.
- Never store provider or GitHub secrets in repository files, workflow source,
  run prompts, artifacts, comments, or logs.
- Treat every task document, PR body, comment, diff, patch, and model output as
  untrusted input.
- Keep Manager changes inside lifecycle, persistence, public API, provider
  routing, or stable inspection/mutation boundaries.
- Require deterministic evidence for every hard gate.

## Phase 0: Freeze And Characterize

### AFV2-001: Record the current Auto Fix baseline

- [ ] Add a fixture that asserts the current compiled node/edge/kind counts.
- [ ] Record the five observed production failure classes without embedding
      private logs or credentials.
- [ ] Characterize current candidate checkpoint recovery and Draft PR adapter
      behavior.
- [ ] Add a regression assertion that v2 work does not change workflow id
      `auto-fix` or its existing runtime graph.

Done when the existing scenario has a stable compatibility baseline and can be
kept as a rollback path.

## Phase 1: Immutable Run Inputs

### AFV2-101: Persist content-addressed run input artifacts

- [ ] Define the public protocol descriptor and bounded staging request.
- [ ] Persist immutable metadata and content digest under Manager ownership.
- [ ] Enforce file count, size, media type, name, and relative-path limits.
- [ ] Bind staged artifact ids atomically to a newly created run.
- [ ] Retain inputs with run evidence and apply the existing redaction rules.
- [ ] Reject an artifact id owned by another project/caller scope.

Likely code areas:

- `homerail_protocol/src/manager-agent-tools.ts`
- Manager run-creation protocol and persistence modules
- Manager Agent tool implementations
- CLI `run` and supervised-run argument handling

### AFV2-102: Project run inputs read-only

- [ ] Expose logical inputs at a stable `$run_input/<logical_name>` resolver.
- [ ] Materialize or mount Worker input paths read-only through Manager/Node
      policy, never through arbitrary caller host paths.
- [ ] Verify the content digest before first dispatch and cold recovery.
- [ ] Reject traversal, symlink, remount, overwrite, and mutable-alias attacks.
- [ ] Expose input descriptors and digests through run inspection.

Tests:

- [ ] staging and idempotent content-addressing;
- [ ] atomic run binding and recovery;
- [ ] size, type, path, and project-scope rejection;
- [ ] write denial from Agent and command nodes;
- [ ] Worker cannot access any unstaged host path.

## Phase 2: Secure Dynamic Workers

### AFV2-201: Add a canonical fan-out worker runtime policy

- [ ] Add a strict WorkflowSpec worker template or node reference containing
      Agent, tool, workspace, credential, call-budget, and session policy.
- [ ] Compile the worker policy into canonical IR and include it in workflow
      hashing.
- [ ] Copy the canonical policy to every dynamically appended child.
- [ ] Make dynamic-child defaults fail closed.
- [ ] Preserve the effective policy across correction and replay.
- [ ] Persist and expose an effective policy digest per child.

Likely code areas:

- `homerail_manager/src/orchestration/workflow-spec-v1-schema.ts`
- `homerail_manager/src/orchestration/workflow-spec-v1.ts`
- `homerail_manager/src/runtime/active-runs.ts`
- dispatch capability and runtime-policy projection

Tests:

- [ ] child inherits exact built-in and DAG tool allowlists;
- [ ] child inherits workspace restrictions and tool-call budget;
- [ ] child cannot acquire undeclared credentials or broker actions;
- [ ] correction and recovery do not widen policy;
- [ ] old `worker_agent` workflows remain compatible without permissive
      write/credential defaults.

### AFV2-202: Add isolated fan-out worktrees

- [ ] Create one credential-free worktree or equivalent immutable snapshot per
      dynamic child from the same source SHA.
- [ ] Restrict each child to its own writable root.
- [ ] Return bounded patch artifacts instead of shared working-tree mutations.
- [ ] Clean up physical worktrees without deleting durable patch evidence.
- [ ] Detect overlapping files and provide deterministic conflict metadata to
      aggregation.

Tests:

- [ ] two workers editing the same path cannot race through a shared checkout;
- [ ] one worker cannot read or write another worker's private mutable state;
- [ ] all patch artifacts declare the same expected base SHA;
- [ ] cleanup is safe after success, failure, timeout, and Manager restart.

## Phase 3: Fresh Dispatch Context

### AFV2-301: Add explicit provider session scope

- [ ] Add `session_scope: dispatch` to the reusable Agent runtime policy.
- [ ] Allocate a new provider session id for every dispatch and loop iteration.
- [ ] Prevent provider-native transcript resume in dispatch scope.
- [ ] Retain transcript evidence without feeding it into the next dispatch.
- [ ] Make the selected scope visible through run/node inspection.

Tests:

- [ ] repeated execution of one logical review node uses distinct provider
      session ids;
- [ ] a dynamic fixer gets a new provider session;
- [ ] review prompts contain only declared task, PR, validation, and finding
      inputs;
- [ ] restart/replay cannot accidentally resume an old provider transcript.

## Phase 4: GitHub PR Capability Broker

### AFV2-401: Implement read-only PR snapshots

- [ ] Add a `github_pr` Manager broker with `snapshot` and `read_checks`.
- [ ] Bind repo, PR, Draft state, base branch/SHA, head branch/SHA, and policy id
      to the run.
- [ ] Reject fork PRs, non-Draft PRs, disallowed branches, closed PRs, and
      mismatched repositories in the pilot.
- [ ] Return bounded, redacted, immutable receipts.

### AFV2-402: Implement fast-forward `push_patch`

- [ ] Accept only a persisted patch artifact and exact `expected_head_sha`.
- [ ] Revalidate path, file count, size, binary, symlink, submodule, and secret
      restrictions in trusted code.
- [ ] Apply the patch to a fresh trusted checkout with hooks and credential
      helpers disabled.
- [ ] Commit with a fixed bot noreply identity.
- [ ] Re-read the remote head immediately before a fast-forward-only push.
- [ ] Return old/new head, commit, patch digest, run/node/session/generation, and
      timestamp in an immutable receipt.
- [ ] Reject force push, merge, approve, ready, close, retarget, branch delete,
      and arbitrary GitHub API operations.

Tests:

- [ ] unauthorized node and action rejection;
- [ ] secret values never enter Worker input, error output, or audit events;
- [ ] expected-head mismatch produces `head_drift` and no push;
- [ ] forbidden paths and malformed patches are rejected twice: collection and
      broker application;
- [ ] concurrent push race cannot overwrite a remote commit;
- [ ] exact idempotent retry returns the original receipt.

## Phase 5: Auto Fix v2 Workflow

### AFV2-501: Define bounded workflow contracts

- [ ] Adopt the caller-facing
      [`task document template`](scenarios/auto-fix-v2-task-template.md) and
      validate that its staged digest is the run's task identity.
- [ ] Add `TaskManifest`, `PRContext`, `BoundTask`, `WorkPlan`, `WorkItem`,
      `ImplementationResult`, `AggregateCandidate`, `ValidationResult`,
      `ReviewVerdict`, `FixResult`, `LoopState`, and `AutoFixV2Result`.
- [ ] Bound every string, array, patch, log, finding set, file set, and round.
- [ ] Require stable finding ids and exact source/head SHAs.
- [ ] Reject incomplete success handoffs rather than synthesizing success.

### AFV2-502: Build the planner and implementation fan-out

- [ ] K3 emits one to three independent WorkItems or `needs_human`.
- [ ] Reject arbitrary graph mutation and dependent parallel tasks.
- [ ] Dynamically create one DeepSeek V4 Flash implementer per item.
- [ ] Run each child in its isolated worktree without a PR broker.
- [ ] Capture and validate one patch artifact per successful child.

### AFV2-503: Build aggregation and validation

- [ ] Apply worker patches in the WorkPlan's declared order.
- [ ] Give DeepSeek V4 Flash an integration worktree and bounded conflict
      metadata.
- [ ] Deterministically collect the aggregate patch.
- [ ] Let the aggregator push the patch-safe first candidate through the
      fenced broker.
- [ ] Run trusted repository validation against the exact pushed head before
      any GLM review.
- [ ] Convert validation failures into structured fixer findings.

### AFV2-504: Build the five-round review/fix loop

- [ ] Push each collected candidate through `push_patch` using exact head
      fencing; a Draft PR may temporarily hold a candidate that later fails
      validation.
- [ ] Dispatch GLM-5.2 with fresh context against the exact pushed head.
- [ ] On rejection, dynamically create one fresh DeepSeek V4 Flash fixer.
- [ ] Make every fix produce a new validated patch and broker receipt.
- [ ] Allow fixers after rounds 1 through 4 only.
- [ ] End a round-5 failure as `needs_human` with complete evidence.
- [ ] End approval as `ready_for_human`; never change Draft state.

### AFV2-505: Add the mixed-model runtime profile

- [ ] Resolve one active K3 setting for `planner`.
- [ ] Resolve one active DeepSeek V4 Flash setting for `implementer`,
      `aggregator`, and `fixer`.
- [ ] Resolve one active GLM-5.2 setting for `reviewer`.
- [ ] Require the compatible harness and endpoint for every setting.
- [ ] Add preflight smokes for built-in tools, structured handoff, and fresh
      context.
- [ ] Fail explicitly when DeepSeek V4 Flash is unavailable; do not substitute
      `deepseek-chat`, `deepseek-reasoner`, or another model.

Likely new assets:

- `assets/orchestrations/auto-fix-v2.yaml.template`
- `scripts/configure-auto-fix-v2-runtime-profile.mjs`
- `docs/scenarios/auto-fix-v2.md`

## Phase 6: Evidence, CLI, And Recovery

### AFV2-601: Make the run inspectable

- [ ] Show task digest, PR binding, current expected head, round, WorkPlan
      digest, dynamic children, policy digests, patches, validation, findings,
      fixers, and broker receipts in supported inspection surfaces.
- [ ] Make `hr templates list` report strict v1 static nodes and bounded dynamic
      worker capacity accurately.
- [ ] Ensure `hr dag quick`, chats, handoffs, scorecard, eval-run, and replay
      retain enough evidence to explain every terminal outcome.

### AFV2-602: Recover without transcript state

- [ ] Recover from task artifact, workflow revision, profile identity, PR head,
      WorkPlan, patches, loop state, and receipts.
- [ ] Continue only when task digest and current PR head match durable state.
- [ ] Preserve and report `head_drift`, expired input, invalid artifact, and
      missing-evidence outcomes.
- [ ] Stop or suspend the logical run explicitly when the outer CI job times
      out.

## Phase 7: Pilot

### AFV2-701: Deterministic and fake-remote proof

- [ ] Run schema, compiler, policy, recovery, and broker tests with deterministic
      Agents and a local fake Git remote.
- [ ] Demonstrate at least two fan-out children and one rejected review/fix
      round.
- [ ] Demonstrate denial of an implementer PR write and denial of a Reviewer
      push.
- [ ] Demonstrate round-5 `needs_human` without a sixth candidate.

### AFV2-702: Dry-run shadow mode

- [ ] Run against a real Draft PR snapshot with broker writes disabled.
- [ ] Produce the exact patches and broker requests that would have occurred.
- [ ] Verify no remote mutation and complete retained evidence.

### AFV2-703: First real Draft-PR pilot

Select an owner-authored task with:

- [ ] one to three independent work items;
- [ ] fewer than approximately twenty changed files;
- [ ] no workflow, credential, dependency, migration, release, or
      security-sensitive infrastructure changes;
- [ ] a pre-created same-repository Draft PR and automation-owned head branch;
- [ ] explicit deterministic validation commands in the task document.

As of 2026-08-01, the recommended multi-worker pilot candidate is
[`xiaotianfotos/homerail#172`](https://github.com/xiaotianfotos/homerail/issues/172).
It has two parallel-safe work areas: deterministic reviewer-identity
canonicalization and terminal-state classification. It has concrete production
evidence and regression criteria, and does not require credentials, migrations,
dependency changes, release automation, or GitHub workflow edits. The caller
must still create a new same-repository Draft PR and revalidate the Issue state
before the run starts.

The pilot passes when:

- [ ] the immutable task digest remains stable across the complete run;
- [ ] every implementation child is isolated and credential-free;
- [ ] every GLM review has a distinct provider session;
- [ ] at least one candidate is pushed fast-forward through the broker;
- [ ] the exact final head passes deterministic validation;
- [ ] the PR remains Draft and unapproved;
- [ ] the result is `ready_for_human` with complete evidence;
- [ ] no capability policy violation occurs.

## Adoption Gate

Do not replace the current workflow until at least four of five eligible pilot
tasks:

- produce a deterministically validated Draft PR;
- complete within the agreed wall-time budget;
- survive retry/recovery without task loss;
- require no hidden credentials or host mounts;
- produce an operator-readable terminal reason;
- show zero unauthorized PR operations or workspace-policy violations.

After the gate, decide separately whether to deprecate `auto-fix`, retain it as
a compatibility fixture, or migrate its public trigger to v2.

## Explicitly Out Of Scope

- automatic merge, approval, ready-for-review transition, or branch deletion;
- force push or conflict resolution against human head drift;
- arbitrary host mounts and caller-selected shell commands;
- fork or cross-repository PRs;
- more than three initial implementation children;
- arbitrary planner-generated graphs or dependent child DAGs;
- self-hosting the first pilot by asking Auto Fix v2 to implement itself.

# Auto Fix v2: Document-First, Draft-PR-Backed Repair

Status: Opt-in MVP implemented and locally verified; real Draft-PR pilot
pending

This document defines a replacement architecture for the current Auto Fix
scenario. It keeps the existing workflow available for rollback and introduces
`auto-fix-v2` as a manual, shadow-mode scenario until the new control-plane
primitives have been proven on real Draft pull requests.

The central rule is that an immutable task document is the source of truth.
The Draft pull request is a mutable delivery surface, and model conversation
history is never required to recover the task.

The current MVP enforces immutable inputs, secure dynamic fan-out, fresh review
sessions, fenced PR reads/writes, and a Manager-side required-checks approval
gate. The gate binds an immutable list of exact GitHub check names to the
current PR head and the current fresh reviewer dispatch. A real Draft-PR pilot
remains necessary before production adoption.

## Problem Statement

The current [`auto-fix.yaml.template`](../scenarios/auto-fix.md) combines issue
sanitization, repository preparation, investigation, implementation, patch
capture, three independent reviews, revision, re-review, arbitration,
publication, checkpointing, validation, and Draft PR creation.

The compiled workflow has 47 nodes and 70 edges against limits of 48 nodes and
80 edges. Twenty-four nodes are terminal outcomes. The workflow also contains
two nearly identical patch collectors for the initial implementation and the
single revision.

Recent production runs have failed at multiple unrelated layers: orchestration,
external fetches, timeout handling, publication, and deterministic build
validation. In one run the model reviewers approved a candidate that later
failed the real Vite build. More review roles therefore do not solve the core
problem: the workflow has too many states, and model consensus is being asked
to stand in for durable task state and deterministic evidence.

## Goals

- Bind every run to an immutable, content-addressed task document.
- Bind every mutable PR operation to an exact repository, PR number, branch,
  base SHA, and expected head SHA.
- Use K3 to produce a bounded work plan.
- Dynamically fan out one to three independent DeepSeek V4 Flash implementers.
- Use a DeepSeek V4 Flash aggregator to integrate worker patches.
- Use a fresh-context GLM-5.2 reviewer for every review round.
- Dynamically create a fresh DeepSeek V4 Flash fixer when validation or review
  rejects the current candidate.
- Bound the complete candidate/review loop to five rounds.
- Give remote PR write capability only to the aggregator and fixers, through a
  Manager-side broker. Reviewers receive read-only PR capability.
- Preserve enough durable state to recover without an Agent transcript.
- Put deterministic validation before model approval.

## Non-Goals

- Automatically approving, marking ready, merging, retargeting, or closing a
  pull request.
- Force-pushing or deleting a branch.
- Passing GitHub tokens, SSH keys, or credential files into Workers.
- Mounting arbitrary caller-selected host paths into Workers.
- Supporting fork pull requests, cross-repository changes, or multiple PRs in
  the first release.
- Letting the planner emit arbitrary graph patches. The first release supports
  a bounded list of parallel-safe work items only.
- Replacing the current Auto Fix workflow before the pilot gates pass.

## Invariants

1. `task_document_sha256` never changes during a run.
2. Every patch names the exact source tree SHA against which it was produced.
3. Every PR write uses an `expected_head_sha` precondition and is
   fast-forward-only.
4. A dynamic child receives an explicit, fail-closed tool, workspace,
   credential, and session policy.
5. Implementers never receive remote repository credentials or PR mutation
   tools.
6. A model claim that a command passed is not validation evidence. Only a
   trusted command result can satisfy a validation gate.
7. A review round uses a new provider session and receives no prior model
   transcript.
8. Missing evidence, head drift, invalid contracts, exhausted rounds, and
   incomplete validation produce explicit non-success outcomes.
9. A handoff whose verdict is `approve` requires a successful receipt for all
   immutable required checks from that same reviewer dispatch.
10. The final successful outcome is `ready_for_human`, not merge approval.

## Proposed Flow

```text
caller creates immutable task input and identifies an existing Draft PR
  -> bind task SHA + immutable PR base/head snapshot
  -> K3 planner emits 1..3 parallel-safe WorkItems
  -> dynamic DeepSeek implementers work in isolated worktrees
  -> deterministic patch collection and safety checks
  -> DeepSeek aggregator integrates patches in declared order
       -> broker fast-forward pushes candidate round 1 to Draft PR
  -> candidate round 1
       -> trusted required checks are evaluated on the exact pushed head
       -> fresh GLM review of task + current diff + validation evidence
       -> approve: Manager verifies the current-dispatch checks receipt
                   -> final evidence publication -> ready_for_human
       -> reject: fresh DeepSeek fixer -> broker pushes next candidate round
  -> candidate round 5 rejection: needs_human
```

One round is one candidate evaluation. A validation failure and a GLM review
failure both consume the current round. Rounds 1 through 4 may create a fixer.
A failure in round 5 terminates as `needs_human`; it does not create a fixer
whose output would require a sixth evaluation.

## Run Input Artifacts

### Why prompt text is insufficient

The current Manager Agent `create_and_run` surface accepts a workflow, profile,
prompt, and run id. A prompt does not provide immutable file identity, durable
content storage, or a safe way for a Worker to access a caller-local design
document. Workers also cannot see arbitrary host paths.

### Proposed API

Add a staging operation that writes bounded content to Manager-owned,
content-addressed storage:

```json
{
  "name": "task.md",
  "media_type": "text/markdown",
  "content": "..."
}
```

It returns an immutable descriptor:

```json
{
  "artifact_id": "run-input-...",
  "sha256": "...",
  "size_bytes": 12345,
  "media_type": "text/markdown"
}
```

`create_and_run` and `start_supervised_dag` then accept bounded input bindings:

```json
{
  "workflow_id": "auto-fix-v2",
  "profile": "auto-fix-v2-mixed",
  "input_artifacts": [
    {
      "artifact_id": "run-input-...",
      "logical_name": "task_document",
      "mount_path": "input/task.md"
    }
  ]
}
```

Requirements:

- accept at most 16 files and 1 MiB per file in the first version;
- allow only declared text and JSON media types;
- validate names and relative mount paths before storage;
- bind artifacts atomically when the run is created;
- store the descriptor and digest in immutable run provenance;
- expose the content to Workers through a Manager/Node-controlled read-only
  projection, never a caller-selected host bind mount;
- expose a read-only `$run_input/<logical_name>` resolver to trusted command
  nodes;
- verify the digest when materializing and whenever recovery reconstructs a
  run;
- retain inputs at least as long as run evidence and checkpoints;
- reject writes to the projected input path at the sandbox boundary.

The task document itself should contain the objective, constraints, detailed
design, acceptance criteria, excluded paths, and required validation. PR
metadata belongs in the structured run input, not in the document body. Use the
[`Auto Fix v2 task template`](../scenarios/auto-fix-v2-task-template.md) as the
caller-facing authoring contract.

## PR Binding

The caller creates or selects an existing Draft PR before starting the DAG. The
run binds this immutable context:

```json
{
  "version": 1,
  "owner": "owner",
  "repo": "name",
  "pull_number": 123,
  "clone_url": "https://github.com/owner/name.git",
  "head_ref": "autofix/task-123",
  "base_ref": "main",
  "initial_head_sha": "...",
  "base_sha": "...",
  "task_document_sha256": "...",
  "require_draft": true,
  "writable_paths": ["src", "tests"],
  "required_checks": ["Core (Linux, Node 24)"]
}
```

The binding command verifies that the PR is open, is a Draft, is in the same
repository, targets an allowed base branch, and has an allowed automation head
branch. Each successful push returns a new head SHA, which becomes the only
valid precondition for the next round.

If a human or another automation changes the PR head during a run, the run
enters `head_drift` and stops mutating the PR. It must not silently merge,
rebase, force-push, or re-plan against the new head. A caller may start a new run
using the same task document revision and a new PR snapshot.

## Workflow Contracts

The WorkflowSpec should define these bounded contracts:

| Contract | Required content |
| --- | --- |
| `TaskManifest` | artifact id, digest, media type, size, logical path |
| `PRContext` | repo, PR, draft state, base/head branches and SHAs, explicit writable prefixes, exact required-check names |
| `BoundTask` | task manifest plus verified PR context and policy id |
| `WorkPlan` | plan digest, 1..3 work items, integration order, global validation |
| `WorkItem` | id, objective, allowed paths, acceptance checks, context paths, risk |
| `ImplementationResult` | work item id, base SHA, patch artifact, files, tests, status |
| `AggregateCandidate` | ordered input patch digests, candidate patch, files, tests |
| `ValidationResult` | exact command ids, exit status, bounded logs, evidence digest |
| `ReviewVerdict` | round, reviewed head SHA, approve/request_changes, findings |
| `FixResult` | round, reviewed head SHA, patch artifact, resolved finding ids |
| `LoopState` | task SHA, current PR head, round, candidate and evidence digests |
| `AutoFixV2Result` | ready_for_human/needs_human/blocked and complete provenance |

Every finding must have a stable id, severity, file, optional line, evidence,
and a concrete expected correction. The fixer reports which finding ids it
resolved or rejected.

### Planner restrictions

The K3 planner may emit one to three work items. In the first release every item
must be parallel-safe:

- no dependencies on another work item's uncommitted output;
- an explicit allowed-path set;
- an explicit acceptance check;
- a declared integration order;
- overlapping paths identified as a conflict risk.

If the task cannot be represented safely, the planner emits one combined work
item or `needs_human`. It does not request arbitrary dynamic nodes or edges.

## Secure Dynamic Fan-Out

The current `fanout` gateway records only a worker Agent and bounded execution
settings. Dynamically appended child nodes do not currently inherit the full
Agent node runtime policy.

Extend the strict v1 fan-out configuration with a validated worker template:

```yaml
config:
  input: plan
  item_field: work_items
  max_items: 3
  max_parallelism: 3
  completion: all
  worker:
    agent: implementer
    session_scope: dispatch
    allowed_builtin_tools: [Bash, Read, Write, Edit, Grep, Glob]
    allowed_dag_tools: [handoff]
    max_builtin_tool_calls: 50
    workspace_access:
      writable_paths: [worktree]
      readonly_paths: [input, evidence]
    credentials: []
    workspace:
      mode: isolated_worktree
      source: repository
```

The exact final syntax may reuse a common `AgentRuntimePolicy` schema, but its
semantics must be:

- the compiler validates the complete template;
- every child receives a canonical copy of it;
- omitted tool allowlists are empty for dynamic children;
- omitted credentials mean no credentials;
- omitted workspace access means no writable paths;
- only `handoff` is available unless DAG tools are declared explicitly;
- each child has a unique logical actor, provider session, and isolated
  worktree based on the same immutable source SHA;
- child corrections retain the same policy and cannot broaden it;
- runtime events expose the effective policy digest for audit.

The existing `worker_agent` form may remain for compatibility, but it must not
create write-capable or credential-bearing children through permissive defaults.

## Aggregation

Implementers hand off patch artifacts; they do not merge branches or push.
Trusted patch collection verifies each artifact against its declared base SHA,
rejects forbidden paths and binary/symlink/submodule changes, and records the
patch digest.

The DeepSeek aggregator receives the immutable task, WorkPlan, bounded worker
reports, patches, and conflict metadata. It applies patches in the WorkPlan's
declared order to a separate integration worktree. It may resolve integration
conflicts and add glue changes, but all resulting changes remain subject to the
global path policy and deterministic patch collector.

The aggregator is the first model node allowed to request a PR write. It does
so by passing bounded file bytes and the exact expected head SHA to the Manager
broker. It never receives the underlying credential.

## Trusted Required-Checks Approval Gate

Each implementer runs focused checks named by its WorkItem. After the aggregator
or fixer pushes a candidate, trusted repository validation publishes GitHub
check runs on that exact head. The immutable `PRContext.required_checks` list is
selected by the caller, not by a model.

- `checks_snapshot` provides bounded evidence to GLM but cannot authorize an
  approval.
- Before handing off `verdict: approve`, the fresh reviewer dispatch must call
  `required_checks` through its read-only Manager broker capability.
- The broker requires the newest run for every exact configured check name to
  be `completed` with conclusion `success` on the bound current head.
- Runtime records only a bounded action receipt, never the credential or
  provider body, and accepts it only for the same node provider session.
- The handoff requirement is conditional on the structured verdict, so changing
  an output port cannot bypass the approval fence.

The Draft PR may temporarily contain a candidate that fails validation; it is a
WIP delivery surface. Missing, pending, cancelled, or failed checks block only
approval, so GLM can still request a bounded fix. In this repository Draft PR
CI is skipped by default, so the operator must manually dispatch trusted CI on
the exact automation head branch before an approval can complete.

## Fresh-Context Review And Fix Rounds

Add a declarative dispatch-scoped session policy for Agent nodes and dynamic
workers. `session_scope: dispatch` means:

- Manager creates a new provider session id for every dispatch;
- no provider-native transcript is resumed;
- corrections and later loop iterations receive new session ids unless a node
  explicitly declares another supported scope;
- the run still retains all transcripts as audit evidence, but they are not
  model input.

GLM receives only the immutable task, current PR context and diff, current
validation result, and bounded repository evidence. A new DeepSeek fixer
receives those inputs plus the current structured findings. Neither receives
previous review prose that is absent from the current contract.

An approval receipt from one dispatch is not valid in a later dispatch, even
when it is the same logical review node after recovery or a loop iteration.

Tests must assert unique provider session ids, not merely different logical
round ids.

## GitHub PR Capability Broker

The Manager-side `github_pr` broker implements these first-version actions:

| Action | Purpose |
| --- | --- |
| `pull_request_snapshot` | Return bounded immutable PR metadata and diff identity |
| `checks_snapshot` | Return bounded checks for the current exact head SHA |
| `required_checks` | Fail unless every immutable required check succeeds on that head |
| `commit_files` | Create bounded blobs/tree/commit and fast-forward the bound head branch |

`commit_files` enforces:

- the run's exact repository, PR, base branch, and head branch binding;
- `expected_head_sha` equals the remote PR head immediately before push;
- no force push and no non-fast-forward update;
- explicit writable prefixes (`"."` is invalid) and an unconditional deny for
  `.github/**`, `.git/**`, and mounted input paths;
- at most 64 unique regular-file paths and 1 MiB total decoded bytes;
- regular or executable blob modes only, with no delete, symlink, or submodule
  operation;
- a bounded single-line commit message;
- durable current/pending-head reconciliation across Manager recovery.

GitHub's blob/tree/commit/ref calls are not atomic as a group. A failure before
the final non-force ref update may leave unreachable Git objects, but cannot
advance the PR head. File/byte bounds, expected-head recovery, and operator
rate-limit discipline keep this failure mode bounded.

The broker must never expose token values or provider error bodies containing
secrets. It must reject calls from nodes that lack both the
`credential_broker_call` DAG tool and the exact declared action.

### Node permission matrix

| Role | Repository workspace | Built-in tools | PR broker |
| --- | --- | --- | --- |
| Binder | trusted command | fixed command only | `pull_request_snapshot` |
| K3 planner | read-only evidence | Read/Grep/Glob | none |
| DeepSeek implementer | isolated worktree | bounded read/write/shell | none |
| DeepSeek aggregator | integration worktree | bounded read/write/shell | `pull_request_snapshot`, `commit_files` |
| GLM reviewer | read-only snapshot/evidence | Read/Grep/Glob | `pull_request_snapshot`, `checks_snapshot`, `required_checks` |
| DeepSeek fixer | fresh integration worktree | bounded read/write/shell | `pull_request_snapshot`, `commit_files` |
| Finalizer | trusted command | fixed command only | `pull_request_snapshot`, `required_checks` |

Reviewer mutation is intentionally excluded. If operator-visible comments are
required later, add only `post_comment`; never grant review approval or merge
actions.

## Model Routing

The workflow remains provider-neutral. Model bindings live in a DB runtime
profile:

| Agent role | Required setting |
| --- | --- |
| `planner` | K3 |
| `implementer` | DeepSeek V4 Flash |
| `aggregator` | DeepSeek V4 Flash |
| `fixer` | DeepSeek V4 Flash |
| `reviewer` | GLM-5.2 |

Before a real run, the stable adapter resolves each selector to exactly one
active LLM setting, confirms the required compatible harness and endpoint, and
runs bounded capability smokes for tool use, structured handoff, and fresh
session behavior. DeepSeek V4 Flash is not currently a built-in catalog model,
so the pilot must treat it as an explicitly configured custom setting rather
than silently selecting another DeepSeek model.

## Recovery And Durable State

The durable loop state is data, not conversation:

```text
task document artifact + SHA
PR binding + current expected head SHA
WorkPlan + digest
worker patch artifacts + digests
aggregate/fix candidate + digest
round number
deterministic validation result
current ReviewVerdict
broker action receipts
```

On recovery:

1. verify the task artifact digest;
2. restore the exact WorkflowSpec revision and runtime profile identity;
3. resolve the current PR head through the broker;
4. continue only when it equals the stored expected head;
5. otherwise enter `head_drift` and retain all evidence.

Outer CI timeout handling should stop or suspend the logical run explicitly and
retain all input, actor, handoff, patch, review, validation, and broker records.

## Observability

The run summary and CLI should expose:

- task document digest and PR base/head binding;
- planner model and WorkPlan digest;
- number of fan-out children, their effective policy digests, worktree ids,
  status, patch digest, and focused tests;
- aggregation order and conflicts;
- candidate round, validation status, reviewer provider session id, finding
  ids, and fixer id;
- every broker call with redacted input and immutable receipt;
- final outcome and the next human action.

Template listing and validation should report dynamic worker templates and
their effective node/parallelism limits instead of showing zero nodes for a
strict v1 template.

## Pilot And Rollout

1. Land the four control-plane prerequisites behind explicit feature flags.
2. Test them with deterministic providers and a fake GitHub remote.
3. Add `auto-fix-v2` as a new workflow id; do not change `auto-fix`.
4. Run `dry_run` mode, which produces patches and broker requests but cannot
   push.
5. Select an owner-authored, low-risk Issue with an existing Draft PR, at most
   three independent work items, and fewer than approximately twenty changed
   files.
6. Exclude `.github/**`, credentials, dependency upgrades, migrations, release
   automation, and security-sensitive infrastructure from the first pilot.
7. Run one real Draft-PR pilot with no auto-ready or merge behavior.
8. Expand only after at least four of five eligible pilots produce a validated
   Draft PR within the agreed runtime budget and no capability boundary is
   violated.

The current Auto Fix workflow can be deprecated only after the pilot evidence
shows that v2 has better completion rate, wall time, recovery, and operator
clarity.

## Open Decisions

- Whether run input blobs live in the Manager database or a Manager-owned
  content-addressed file store. The public contract should not depend on this.
- Whether `session_scope` belongs to `AgentNode`, the reusable runtime policy,
  or both. The canonical IR must resolve it to one explicit value.
- Whether validation failures and model review failures share one five-round
  budget. This proposal says yes to preserve a hard upper bound.
- Whether reviewer comments should be posted during the pilot. The safer
  default is to keep review evidence inside HomeRail and post only the final
  summary after human inspection.

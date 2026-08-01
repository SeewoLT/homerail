# Auto Fix v2 Task Document Template

This template is the human-readable source document staged as the immutable
`task_document` input of an Auto Fix v2 run. The caller may generate it through
Manager Agent or another trusted client, but must review it before staging.

The run binds the staged document by SHA-256. Do not edit the staged content in
place. A task change creates a new document revision and a new run.

PR number, repository, branches, base/head SHAs, credentials, and executable
validation commands are structured control-plane inputs. They must not be
copied into this document as authoritative runtime configuration.

---

# <Task title>

## Task Identity

- Source Issue: `<owner/repository>#<number>`
- Task revision: `<caller-defined revision>`
- Prepared by: `<Manager Agent, person, or external caller>`
- Prepared at: `<ISO-8601 timestamp>`

These fields are provenance for readers. The staged artifact digest is the
runtime identity.

## Objective

Describe one concrete outcome. State what a user or operator can do after the
change that they cannot do now.

## Current Behavior And Evidence

Describe the observed behavior and why it is wrong or incomplete. Include
bounded, reproducible evidence such as relevant files, failing test names,
error categories, or public references. Separate verified facts from
assumptions.

## Desired Behavior

Describe the expected externally visible and internal behavior. Include failure
and recovery behavior where relevant.

## Proposed Design

Provide the implementation direction in enough detail that the K3 planner can
divide it without rediscovering the architecture. Identify the preferred
product layer and explain any Manager change under the allowed Manager
categories.

```text
Layer Decision:
- Problem layer:
- Preferred fix layer:
- Manager touched: yes/no
- Manager Change Justification: <allowed category or n/a>
- Rejected shortcuts:
- Public entry path:
- Validation path:
```

## Required Invariants

- `<invariant that must remain true>`
- `<security, compatibility, persistence, or recovery invariant>`

## Repository Scope

### Allowed paths

- `<path or bounded path prefix>`

### Read-only context paths

- `<path or bounded path prefix>`

### Explicitly forbidden paths

- `.github/workflows/**`
- `.gitmodules`
- credential, secret, signing-key, and private environment files
- `<task-specific forbidden path>`

The runtime repository policy remains authoritative and may be stricter than
this list. This document cannot grant access that the run policy denies.

## Work Decomposition Guidance

List likely independent areas, if known. These are hints rather than dynamic
graph instructions.

1. `<parallel-safe area and expected output>`
2. `<parallel-safe area and expected output>`

If two areas depend on uncommitted output from each other, say so. The first
Auto Fix v2 release must combine dependent work into one WorkItem rather than
pretending it is parallel-safe.

## Acceptance Criteria

- [ ] `<observable behavior or contract>`
- [ ] `<failure/recovery behavior>`
- [ ] `<compatibility expectation>`
- [ ] No unrelated changes.

## Validation Requirements

Name the expected trusted validation profile and the evidence it must produce.
Raw commands in this document are explanatory only; the DAG executes commands
from the operator-approved scenario policy.

- Validation profile: `<registered profile id>`
- Focused evidence: `<test suite, fixture, or behavior>`
- Required final evidence: `<build/typecheck/test/scan subset>`

## Risks And Edge Cases

- `<known risk and expected handling>`
- `<head drift, restart, platform, concurrency, or compatibility case>`

## Out Of Scope

- `<explicitly excluded adjacent work>`
- Automatic PR approval, ready transition, merge, force push, or branch delete.

## Human Review Notes

Call out anything the final human reviewer must verify that cannot be proven by
the trusted validation profile.

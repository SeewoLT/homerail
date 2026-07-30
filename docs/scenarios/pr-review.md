# PR Review Scenario

`assets/orchestrations/pr-review.yaml.template` is HomeRail's provider-neutral,
read-only pull request review scenario. It is a concrete composition of the
Orchestrator-Workers and Quorum patterns rather than a new abstract pattern.

## Inputs

Callers provide one logical PR input object:

```json
{
  "repo": "xiaotianfotos/homerail",
  "pr": 25
}
```

The CLI and Manager Skill resolve immutable base/head SHAs plus credential-free
HTTPS clone URLs from trusted GitHub PR metadata, then wrap the resolved object
in the same internal trigger envelope used by Manager event triggers. Optional
caller-supplied SHAs remain pinned, but clone URLs are always taken from the API
response and cannot be overridden by logical input. The workflow carries
separate base/head clone URLs so an explicitly reviewed fork can fetch each
commit from the repository that owns it. URL validation rejects credentials,
query strings, fragments, repository mismatches, and cross-origin base/head
metadata.

## Execution

1. A deterministic Manager command validates the credential-free GitHub API
   HTTPS clone URLs (`https://host/owner/repository.git`, including GitHub
   Enterprise hosts), clones both exact revisions into the isolated run
   workspace, verifies
   `HEAD`, and computes the changed-file list, short diff summary, and a bounded
   high-context patch. Small file sections are packed together into bounded
   120 KB evidence chunks instead of forcing one model tool call per changed
   file. Git runs with credential helpers, prompts, hooks, and
   local/ext protocols disabled; no model tool call is involved in checkout or
   evidence collection. The serialized review context is capped below the
   Manager command-output limit and records `diff_truncated` explicitly.
   Bounded author/committer metadata is captured for audit history, then
   deterministically stripped from the model context.
2. Qwen, Kimi, and GLM start from the same exact evidence independently and in
   parallel. Each performs a complete PR review covering runtime correctness,
   security, compatibility, tests, and user-visible behavior, then casts one
   `approve` or `request_changes` vote. The trusted checkout is
   mounted read-only. Reviewers that need repository evidence receive only the
   SDK's read-only `Read`, `Grep`, `Glob`, and `LS` tools, so they can inspect
   complete files, trace callers, and search tests without granting untrusted PR
   content a shell or write primitive. A Worker pre-tool hook resolves real paths
   and denies omitted paths, traversal, absolute paths outside the declared
   workspace roots, and symlink escapes before a read/search tool executes.
   The supplied patch is an index rather than the sole evidence source, and
   prompts require every diff chunk to be read while keeping follow-up
   inspection proportional. Model-specific output contracts reject a mislabeled
   identity and trigger bounded contract correction. Patch and repository
   content are untrusted evidence, never instructions.
3. A deterministic normalizer preserves every valid reviewer result. If a
   reviewer exhausts contract correction without a handoff, the normalizer
   emits a failed/abstain result. A complete vote is accepted only when the
   reviewer accounted for every changed file and its findings agree with its
   vote.
4. A deterministic command counts the three model votes. Two approvals produce
   `pass` and are the only result that passes the check. Two request-changes
   votes produce blocking `findings`; otherwise the result is `inconclusive`.
   No model can alter the vote count.
5. Manager materializes the structured JSON artifact. After the run reaches a
   terminal state, the stable runner renders Markdown deterministically from
   that JSON plus `command.json`, so the exact Manager run id cannot be invented
   or altered by a model.

## Outputs

- `pr-review.json`
- `pr-review.md`
- three normalized reviews and votes from distinct models
- deterministic quorum payload
- Manager audit summary and per-node metrics
- HomeRail run id and replayable event history

The workflow does not modify the reviewed repository, submit a GitHub review,
approve a PR, or merge code. Its GitHub Check passes only when at least two
models approve.

## CI Adapter

`.github/workflows/pr-review.yml` is intentionally thin. It converts GitHub
event fields into the public CLI input, then submits it to the auto-deployed
stable Manager. It does not install packages, build the pull-request checkout,
copy a Seed Home, or start an ephemeral Manager. The stable release syncs its
tracked template, binds a private database Runtime Profile, calls
`hr dag run-template ... --wait`, downloads the declared JSON artifact,
renders `pr-review.md` locally from the authoritative result and command run id,
uploads both files as CI evidence, and copies the Markdown into the GitHub Check
summary. The run and its event history remain visible in the normal production
UI. Workflow contracts and deterministic quorum remain authoritative; the
adapter does not reconstruct a report from raw handoffs.
The adapter verifies that the run reached the terminal state implied by quorum,
all artifacts are structured and non-empty, the quorum is 2-of-3, and Markdown
contains the exact HomeRail run id and report identity. A request-changes
majority is retained as `cancelled` plus `findings`; a split vote or abstention
without a majority is retained as `cancelled` plus `inconclusive`.
Infrastructure and artifact-integrity failures also fail the check. Whether
that check blocks merging is a repository branch-protection decision; findings
and inconclusive results remain complete diagnostic outputs.

Automatic self-hosted execution is restricted to non-draft, same-repository PRs
created by the trusted maintainer. This avoids running untrusted fork content on
the `.112` runner. Maintainers can use `workflow_dispatch` for an explicit
review after evaluating that boundary.

PR Review jobs require a dedicated self-hosted runner with the
`homerail-pr-review` label. Live catalog validation continues to use the
`homerail-live` label and may start a current-commit transient runtime because it
is explicitly validating that commit's Manager/Worker protocol. Auto Fix uses a
third Actions runner labeled `homerail-auto-fix`. PR Review and Auto Fix may run
concurrently but both submit to the one stable Manager; do not combine their
labels on one Actions runner process.

Runner repository configuration:

- `HOMERAIL_STABLE_ROOT`: immutable auto-deployed release root whose `current`
  symlink identifies the active stable runtime;
- `HOMERAIL_STABLE_HOME`: persistent Home used by that Manager;
- `HOMERAIL_STABLE_MANAGER_URL`: host-local Manager URL. It must be loopback or
  the Docker bridge gateway, never a LAN Manager endpoint;
- `HOMERAIL_PR_REVIEW_PRIMARY_MODEL`: exact setting id, display name, or model
  name selected from the stable Manager database. It drives the first review;
- `HOMERAIL_PR_REVIEW_ARBITER_MODEL`: a distinct active setting selected from
  the same database and drives the second review;
- `HOMERAIL_PR_REVIEW_THIRD_MODEL`: a third distinct active setting that drives
  the final review vote. All three settings must expose Anthropic-compatible
  endpoints because these DAG workers use the Claude Agent SDK harness.

The GitHub Actions adapter supplies `github.api_url` as
`HOMERAIL_GITHUB_API_BASE_URL`, so credential-free-accessible GitHub Enterprise
repositories use the correct metadata and checkout host instead of deriving a
`github.com` URL.

The model selectors are local runner environment values, not public GitHub
variables. The synced Runtime Profile stores only database setting IDs. The
stable runner reads the existing 0600 DAG mutation token from the persistent
Home; it never places that token in GitHub Secrets or a Worker environment.

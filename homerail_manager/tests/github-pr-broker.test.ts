import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseWorkflowSource } from "../src/orchestration/workflow-spec-v1.js";
import { closeDb } from "../src/persistence/db.js";
import { createCredential } from "../src/persistence/credentials.js";
import {
  resolveDagRunInputBindings,
  stageDagRunInputArtifact,
} from "../src/persistence/run-input-artifacts.js";
import {
  _clearActiveRuns,
  createActiveRun,
  recoverAllActiveRuns,
} from "../src/runtime/active-runs.js";
import { executeCredentialBrokerCall } from "../src/runtime/credential-broker.js";

const INITIAL_HEAD = "a".repeat(40);
const BASE_HEAD = "b".repeat(40);
const BASE_TREE = "c".repeat(40);
const BLOB = "d".repeat(40);
const NEXT_HEAD = "e".repeat(40);
const NEXT_TREE = "f".repeat(40);

function workflow(): string {
  const binding = (actions: string) => `
        - credential_ref: github-autofix
          purpose: bounded Draft PR access
          inject:
            mode: manager_broker
            broker: github_pr
            allowed_actions: [${actions}]`;
  return `
api_version: homerail.ai/v1
kind: Workflow
metadata: { id: github-broker-test, name: GitHub broker test }
spec:
  contracts:
    Task: { type: object }
  agents:
    actor: { system: Use only the declared GitHub broker actions. }
  nodes:
    aggregate:
      kind: agent
      agent: actor
      allowed_dag_tools: [handoff, credential_broker_call]
      credentials:${binding("pull_request_snapshot, commit_files")}
      inputs: { task: { contract: Task } }
      outputs: { done: {} }
    reviewer:
      kind: agent
      agent: actor
      allowed_dag_tools: [handoff, credential_broker_call]
      credentials:${binding("pull_request_snapshot, checks_snapshot")}
      inputs: { task: {} }
      outputs: { done: {} }
    implementer:
      kind: agent
      agent: actor
      inputs: { task: {} }
      outputs: { done: {} }
    done: { kind: terminal, outcome: success, inputs: { result: {} } }
  edges:
    - { from: $run.input, to: aggregate.task }
    - { from: aggregate.done, to: reviewer.task }
    - { from: reviewer.done, to: implementer.task }
    - { from: implementer.done, to: done.result }
`;
}

describe("bounded GitHub Draft PR credential broker", () => {
  let home: string;
  let previousHome: string | undefined;
  let remoteHead: string;
  let pullState: string;
  let headRepository: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-github-broker-"));
    process.env.HOMERAIL_HOME = home;
    closeDb();
    _clearActiveRuns();
    remoteHead = INITIAL_HEAD;
    pullState = "open";
    headRepository = "acme/widget";
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = String(init?.method ?? "GET").toUpperCase();
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
      if (method === "GET" && url.pathname === "/repos/acme/widget/pulls/7") {
        return json({
          number: 7,
          title: "WIP autofix",
          body: "Bound task",
          draft: true,
          state: pullState,
          html_url: "https://github.example/acme/widget/pull/7",
          head: { sha: remoteHead, ref: "autofix/issue-172", repo: { full_name: headRepository } },
          base: { sha: BASE_HEAD, ref: "main", repo: { full_name: "acme/widget" } },
        });
      }
      if (method === "GET" && url.pathname === "/repos/acme/widget/pulls/7/files") {
        return json([{ filename: "src/fix.ts", status: "modified", additions: 2, deletions: 1, changes: 3, patch: "@@ fake" }]);
      }
      if (method === "GET" && url.pathname.endsWith("/check-runs")) {
        return json({ check_runs: [{ id: 1, name: "unit", status: "completed", conclusion: "success" }] });
      }
      if (method === "GET" && url.pathname === `/repos/acme/widget/git/commits/${INITIAL_HEAD}`) {
        return json({ tree: { sha: BASE_TREE } });
      }
      if (method === "POST" && url.pathname === "/repos/acme/widget/git/blobs") return json({ sha: BLOB }, 201);
      if (method === "POST" && url.pathname === "/repos/acme/widget/git/trees") return json({ sha: NEXT_TREE }, 201);
      if (method === "POST" && url.pathname === "/repos/acme/widget/git/commits") return json({ sha: NEXT_HEAD }, 201);
      if (method === "PATCH" && url.pathname === "/repos/acme/widget/git/refs/heads/autofix/issue-172") {
        remoteHead = NEXT_HEAD;
        return json({ object: { sha: NEXT_HEAD } });
      }
      return json({ message: `unhandled ${method} ${url.pathname}` }, 404);
    });

    createCredential({
      id: "github-autofix",
      credential_type: "api_key",
      name: "GitHub Autofix App token",
      secret: { value: "github-secret-token-value" },
    }, { actor: "test" });
    const taskArtifact = stageDagRunInputArtifact({
      scope_id: "project-one",
      name: "task.md",
      media_type: "text/markdown",
      content: "# Bounded task\n",
    });
    const prArtifact = stageDagRunInputArtifact({
      scope_id: "project-one",
      name: "pr-context.json",
      media_type: "application/json",
      content: JSON.stringify({
        version: 1,
        owner: "acme",
        repo: "widget",
        pull_number: 7,
        clone_url: "https://github.com/acme/widget.git",
        head_ref: "autofix/issue-172",
        base_ref: "main",
        initial_head_sha: INITIAL_HEAD,
        base_sha: BASE_HEAD,
        task_document_sha256: taskArtifact.sha256,
        require_draft: true,
        writable_paths: ["src", "tests"],
      }),
    });
    const bindings = resolveDagRunInputBindings("project-one", [
      {
        artifact_id: taskArtifact.artifact_id,
        logical_name: "task_document",
        mount_path: "input/task.md",
      },
      {
        artifact_id: prArtifact.artifact_id,
        logical_name: "pr_context",
        mount_path: "input/pr-context.json",
      },
    ]);
    const parsed = parseWorkflowSource(workflow());
    parsed.meta.agents!.actor.agent_type = "deterministic";
    createActiveRun("github-broker-run", parsed, { initialPrompt: "{}", inputArtifacts: bindings });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    _clearActiveRuns();
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    const inputRoot = path.join(home, "workspace", "github-broker-run", "input");
    if (fs.existsSync(inputRoot)) fs.chmodSync(inputRoot, 0o700);
    fs.rmSync(home, { recursive: true, force: true });
  });

  function call(nodeId: string, action: string, input: Record<string, unknown> = {}) {
    return executeCredentialBrokerCall("worker-one", {
      request_id: `${nodeId}-${action}`,
      run_id: "github-broker-run",
      node_id: nodeId,
      session_id: `session-${nodeId}`,
      credential_ref: "github-autofix",
      broker: "github_pr",
      action,
      input,
    });
  }

  it("keeps the token host-side and enforces per-node action and path allowlists", async () => {
    const snapshot = await call("reviewer", "pull_request_snapshot");
    expect(snapshot).toMatchObject({
      ok: true,
      result: { repository: "acme/widget", pull_number: 7, draft: true, head_sha: INITIAL_HEAD },
    });
    expect(JSON.stringify(snapshot)).not.toContain("github-secret-token-value");

    await expect(call("reviewer", "commit_files", {})).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("not permitted"),
    });
    await expect(call("implementer", "pull_request_snapshot")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("not declared"),
    });
    const deniedPath = await call("aggregate", "commit_files", {
      expected_head_sha: INITIAL_HEAD,
      message: "attempt workflow change",
      files: [{ path: ".github/workflows/pwn.yml", content_base64: Buffer.from("bad").toString("base64") }],
    });
    expect(deniedPath).toMatchObject({ ok: false, error: expect.stringContaining("outside the PR write allowlist") });
  });

  it("commits through a non-force expected-head fence and restores the advanced head", async () => {
    const committed = await call("aggregate", "commit_files", {
      expected_head_sha: INITIAL_HEAD,
      message: "fix: bounded change",
      files: [{ path: "src/fix.ts", content_base64: Buffer.from("export const fixed = true;\n").toString("base64") }],
    });
    expect(committed).toMatchObject({
      ok: true,
      result: {
        previous_head_sha: INITIAL_HEAD,
        head_sha: NEXT_HEAD,
        committed_files: ["src/fix.ts"],
      },
    });
    expect(remoteHead).toBe(NEXT_HEAD);
    expect(fetchSpy.mock.calls.find(([, init]) => init?.method === "PATCH")?.[1]?.body)
      .toContain('"force":false');

    _clearActiveRuns();
    closeDb();
    expect(recoverAllActiveRuns().recovered).toContain("github-broker-run");
    const recovered = await call("reviewer", "pull_request_snapshot");
    expect(recovered).toMatchObject({ ok: true, result: { head_sha: NEXT_HEAD } });

    const stale = await call("aggregate", "commit_files", {
      expected_head_sha: INITIAL_HEAD,
      message: "stale write",
      files: [{ path: "src/fix.ts", content_base64: Buffer.from("stale\n").toString("base64") }],
    });
    expect(stale).toMatchObject({ ok: false, error: expect.stringContaining("expected head is stale") });
  });

  it("fails closed when the Draft PR head changes outside the broker", async () => {
    await call("reviewer", "pull_request_snapshot");
    remoteHead = "9".repeat(40);
    const drifted = await call("reviewer", "checks_snapshot");
    expect(drifted).toMatchObject({ ok: false, error: expect.stringContaining("outside the HomeRail broker") });
  });

  it("rejects a closed or cross-repository pull request", async () => {
    pullState = "closed";
    await expect(call("reviewer", "pull_request_snapshot")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("identity differs"),
    });

    pullState = "open";
    headRepository = "someone-else/widget";
    await expect(call("reviewer", "pull_request_snapshot")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("identity differs"),
    });
  });
});

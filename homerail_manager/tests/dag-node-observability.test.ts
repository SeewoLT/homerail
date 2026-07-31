import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { closeDb } from "../src/persistence/db.js";
import {
  _clearAllPersistence,
  appendChatEntry,
  appendNodeUsage,
} from "../src/persistence/store.js";
import { _clearActiveRuns, createActiveRun } from "../src/runtime/active-runs.js";
import { createServer } from "../src/server/http.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function createTestRun(runId: string): void {
  createActiveRun(runId, parseDAGYaml(`
name: node-observability
workflow_id: node-observability
agents:
  worker:
    agent_type: deterministic
    system: HANDOFF port=done content=ok
nodes:
  work:
    agent: worker
    after: []
    outputs:
      done:
        to: ""
`));
}

async function metrics(port: number, runId: string): Promise<Record<string, any>> {
  const response = await fetch(`http://127.0.0.1:${port}/api/dag-status/${runId}/metrics`);
  expect(response.status).toBe(200);
  return await response.json() as Record<string, any>;
}

describe("DAG node observability", () => {
  let server: http.Server;
  let tmpHome: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-node-observability-"));
    process.env.HOMERAIL_HOME = tmpHome;
    _clearActiveRuns();
    _clearAllPersistence();
    server = createServer(0, undefined, undefined, false, { autoDetectCodex: false });
  });

  afterEach(async () => {
    _clearActiveRuns();
    _clearAllPersistence();
    await close(server);
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("persists safe execution identity and cumulative multi-round token metrics", async () => {
    const runId = "node-observability-history";
    createTestRun(runId);
    appendChatEntry(runId, "work", {
      role: "manager",
      type: "prompt",
      targetId: "worker-1",
      content: {
        agentConfig: {
          agent_type: "claude-sdk",
          llm_setting_id: "private-setting-id",
          llm: {
            provider: "anthropic",
            provider_display_name: "Anthropic",
            model: "claude-sonnet",
            model_display_name: "Claude Sonnet",
            protocol: "anthropic_compatible",
            context_limit: 200_000,
            context_usage_pct: 12.5,
            api_key: "sk-private-value-123456",
            base_url: "https://private.example.test",
          },
        },
      },
      timestamp: 1,
    });

    appendNodeUsage({
      runId,
      nodeId: "work",
      scope: { session_id: "session-1", round_id: "round-0001", generation: 1 },
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      },
      duration_ms: 100,
      num_turns: 1,
      timestamp: 2,
    });
    appendNodeUsage({
      runId,
      nodeId: "work",
      scope: { session_id: "session-1", round_id: "round-0001", generation: 1 },
      usage: {
        input_tokens: 12,
        output_tokens: 6,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 3,
      },
      duration_ms: 120,
      num_turns: 1,
      timestamp: 3,
    });
    appendNodeUsage({
      runId,
      nodeId: "work",
      scope: {
        session_id: "session-1",
        round_id: "round-0002",
        generation: 1,
        command_id: "command-2",
        execution_id: "execution-1",
      },
      usage: {
        input_tokens: 7,
        output_tokens: 2,
        cache_read_input_tokens: 1,
        cache_creation_input_tokens: 0,
      },
      duration_ms: 80,
      num_turns: 1,
      timestamp: 4,
    });

    // Prove the endpoint reads historical SQLite metrics, not active-run memory.
    _clearActiveRuns();
    const port = await listen(server);
    const historical = await metrics(port, runId);
    expect(historical.data.nodes.work).toMatchObject({
      execution: {
        provider_id: "anthropic",
        provider_display_name: "Anthropic",
        model_name: "claude-sonnet",
        model_display_name: "Claude Sonnet",
        agent_backend: "claude-sdk",
        protocol: "anthropic_compatible",
        context_limit: 200_000,
        context_usage_pct: 12.5,
      },
      tokens: {
        input: 19,
        output: 8,
        cache_read: 5,
        cache_creation: 3,
        total: 35,
      },
      usage_scope: "node_cumulative",
      usage_available: true,
      duration_ms: 200,
      num_turns: 2,
    });
    expect(historical.data.totals.tokens).toEqual({
      input: 19,
      output: 8,
      cache_read: 5,
      cache_creation: 3,
      total: 35,
    });
    expect(JSON.stringify(historical.data)).not.toContain("private-setting-id");
    expect(JSON.stringify(historical.data)).not.toContain("private.example.test");
    expect(JSON.stringify(historical.data)).not.toContain("sk-private");

    // A newer running-total snapshot replaces only its own round scope.
    appendNodeUsage({
      runId,
      nodeId: "work",
      scope: {
        session_id: "session-1",
        round_id: "round-0002",
        generation: 1,
        command_id: "command-2",
        execution_id: "execution-1",
      },
      usage: {
        input_tokens: 9,
        output_tokens: 4,
        cache_read_input_tokens: 1,
        cache_creation_input_tokens: 0,
      },
      duration_ms: 90,
      num_turns: 1,
      timestamp: 5,
    });
    const refreshed = await metrics(port, runId);
    expect(refreshed.data.nodes.work.tokens).toEqual({
      input: 21,
      output: 10,
      cache_read: 5,
      cache_creation: 3,
      total: 39,
    });

    // A contract-correction prompt is a separate billed execution even when
    // it reuses the same session, round, generation, and command fence.
    appendNodeUsage({
      runId,
      nodeId: "work",
      scope: {
        session_id: "session-1",
        round_id: "round-0002",
        generation: 1,
        command_id: "command-2",
        execution_id: "execution-2",
      },
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      timestamp: 6,
    });
    const corrected = await metrics(port, runId);
    expect(corrected.data.nodes.work.tokens).toEqual({
      input: 24,
      output: 12,
      cache_read: 5,
      cache_creation: 3,
      total: 44,
    });
  });

  it("uses null rather than fake zeroes when identity and usage are unavailable", async () => {
    const runId = "node-observability-unknown";
    createTestRun(runId);
    const port = await listen(server);
    const body = await metrics(port, runId);

    expect(body.data.nodes.work).toMatchObject({
      execution: null,
      tokens: null,
      usage_available: false,
      usage_scope: "node_cumulative",
    });
  });
});

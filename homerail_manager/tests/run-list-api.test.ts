import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb } from "../src/persistence/db.js";
import { writeRunMetadata } from "../src/persistence/store.js";
import { createServer } from "../src/server/http.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}

async function closeServer(server: http.Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("GET /api/runs", () => {
  let home: string;
  let oldHome: string | undefined;
  let server: http.Server | undefined;

  beforeEach(() => {
    closeDb();
    oldHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-run-list-api-"));
    process.env.HOMERAIL_HOME = home;
  });

  afterEach(async () => {
    await closeServer(server);
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("returns terminal summaries without loading aggregate metadata", async () => {
    const createdAt = Date.now();
    writeRunMetadata("large-terminal-run", {
      runId: "large-terminal-run",
      workflowId: "release-review",
      workflowName: "Release review",
      createdAt,
      completedAt: createdAt + 25,
      status: "completed",
      nodeStates: { inspect: "COMPLETED" },
      handoffedNodes: ["inspect"],
      graph: {
        nodes: [{ node_id: "inspect", name: "Inspect" }],
        edges: [],
      },
    });
    // If the route regresses to loadRunMetadata(), this row makes the request
    // fail immediately instead of hiding the N+1 parse behind a fast fixture.
    getDb().prepare("UPDATE dag_runs SET metadata = ? WHERE run_id = ?")
      .run("{ intentionally invalid terminal metadata", "large-terminal-run");

    server = createServer(0, undefined, undefined, false, { autoDetectCodex: false });
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/runs`);
    const body = await response.json() as {
      success: boolean;
      data: {
        runs: Array<Record<string, unknown>>;
        total: number;
      };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        total: 1,
        runs: [{
          runId: "large-terminal-run",
          workflowId: "release-review",
          workflowName: "Release review",
          nodeCount: 1,
          status: "completed",
          createdAt,
          completedAt: createdAt + 25,
        }],
      },
    });
  });
});

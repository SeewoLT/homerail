import type * as http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { dagEnvironmentRoutesHandler } from "../src/server/dag-environment-routes.js";
import type { DagEnvironmentController, DagEnvironmentStatus } from "../src/server/dag-environment.js";

function status(buildStatus?: "queued" | "running"): DagEnvironmentStatus {
  return {
    revision: 4,
    updated_at: 100,
    platform: "linux",
    docker: { status: "ready", message: "ready" },
    source: {
      available: true,
      repo_root: "/repo",
      fingerprint: "abc",
      worker_version: "0.1.0",
      protocol_version: "0.1.0",
    },
    worker_image: {
      status: buildStatus ? "building" : "ready",
      image: "homerail-worker:latest",
      message: "ready",
    },
    images: [],
    workers: [],
    build: buildStatus ? {
      operation_id: "build-1",
      status: buildStatus,
      started_at: 100,
      logs: [],
    } : undefined,
  };
}

async function request(
  method: string,
  url: string,
  controller: Pick<DagEnvironmentController, "getStatus" | "check" | "startBuild">,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    let responseStatus = 0;
    const req = { method, url } as http.IncomingMessage;
    const res = {
      writeHead(code: number) {
        responseStatus = code;
        return this;
      },
      end(chunk?: string) {
        resolve({
          status: responseStatus,
          body: chunk ? JSON.parse(chunk) as Record<string, unknown> : {},
        });
      },
    } as unknown as http.ServerResponse;
    expect(dagEnvironmentRoutesHandler(req, res, controller as DagEnvironmentController)).toBe(true);
  });
}

describe("DAG environment routes", () => {
  it("returns the authoritative snapshot", async () => {
    const controller = {
      getStatus: vi.fn(() => status()),
      check: vi.fn(),
      startBuild: vi.fn(),
    };

    const response = await request("GET", "/api/dag/environment", controller as never);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: { revision: 4 },
    });
  });

  it("accepts a build immediately with its operation id", async () => {
    const controller = {
      getStatus: vi.fn(),
      check: vi.fn(),
      startBuild: vi.fn(() => status("queued")),
    };

    const response = await request("POST", "/api/dag/environment/build", controller as never);

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        build: {
          operation_id: "build-1",
          status: "queued",
        },
      },
    });
  });
});

import type * as http from "node:http";
import {
  getDagEnvironmentController,
  type DagEnvironmentController,
} from "./dag-environment.js";

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function methodNotAllowed(res: http.ServerResponse): void {
  json(res, 405, {
    success: false,
    message: "Method not allowed",
    error: "Method not allowed",
  });
}

export function dagEnvironmentRoutesHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  controller: DagEnvironmentController = getDagEnvironmentController(),
): boolean {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname === "/api/dag/environment") {
    if (req.method !== "GET") {
      methodNotAllowed(res);
      return true;
    }
    json(res, 200, {
      success: true,
      message: "DAG environment status",
      data: controller.getStatus(),
    });
    return true;
  }
  if (pathname === "/api/dag/environment/check") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    void controller.check()
      .then((data) => json(res, 200, {
        success: true,
        message: "DAG environment checked",
        data,
      }))
      .catch((error) => json(res, 500, {
        success: false,
        message: "DAG environment check failed",
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }
  if (pathname === "/api/dag/environment/build") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    const data = controller.startBuild();
    json(res, 202, {
      success: true,
      message: data.build?.status === "running" || data.build?.status === "queued"
        ? "Worker image build accepted"
        : "Worker image build status",
      data,
    });
    return true;
  }
  return false;
}

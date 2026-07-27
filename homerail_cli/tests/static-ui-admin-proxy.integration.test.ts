import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children: ChildProcess[] = [];
const servers: http.Server[] = [];
const sockets = new Set<net.Socket>();
const unexpectedSocketErrors: Error[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const child of children.splice(0)) {
    await stopChild(child);
  }
  for (const server of servers.splice(0)) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const errors = unexpectedSocketErrors.splice(0);
  if (errors.length > 0) {
    throw new AggregateError(errors, "Unexpected WebSocket errors during static UI proxy teardown");
  }
});

describe("static Agent UI mutation proxy", () => {
  it("proxies the Manager event WebSocket used by runtime environment updates", async () => {
    let upgradedPath = "";
    const manager = http.createServer();
    manager.on("upgrade", (req, socket) => {
      trackSocket(socket);
      upgradedPath = req.url || "";
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "\r\n",
      );
      socket.end();
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl,
    });

    const response = await websocketUpgrade(uiPort, "/ws/events");
    expect(response).toContain("HTTP/1.1 101 Switching Protocols");
    expect(upgradedPath).toBe("/ws/events");
  }, 15_000);

  it("builds and proxies Manager events through the packaged UI artifacts", async () => {
    buildPackagedUiArtifacts();
    const packagedUiRoot = path.resolve("..", "agent-ui", "dist");
    const packagedServer = path.resolve("dist", "static-ui-server.js");
    expect(fs.existsSync(packagedServer)).toBe(true);
    expect(fs.existsSync(path.join(packagedUiRoot, "index.html"))).toBe(true);

    let upgradedPath = "";
    const manager = http.createServer();
    manager.on("upgrade", (req, socket) => {
      trackSocket(socket);
      upgradedPath = req.url || "";
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "\r\n",
      );
      socket.end();
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl,
      root: packagedUiRoot,
      entry: "dist",
    });

    const page = await fetch(uiOrigin);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('data-hr-appearance="cockpit"');
    const manifest = await fetch(`${uiOrigin}/homerail-build.json`);
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toMatchObject({ app: "homerail-agent-ui" });

    const response = await websocketUpgrade(uiPort, "/ws/events", uiOrigin);
    expect(response).toContain("HTTP/1.1 101 Switching Protocols");
    expect(upgradedPath).toBe("/ws/events");
  }, 180_000);

  it("proxies the same-origin ASR realtime WebSocket to the Manager", async () => {
    let upgradedPath = "";
    const manager = http.createServer();
    manager.on("upgrade", (req, socket) => {
      trackSocket(socket);
      upgradedPath = req.url || "";
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "\r\n",
      );
      socket.end();
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl,
    });

    const response = await websocketUpgrade(uiPort, "/api/voice/asr/realtime");
    expect(response).toContain("HTTP/1.1 101 Switching Protocols");
    expect(upgradedPath).toBe("/api/voice/asr/realtime");
  }, 15_000);

  it("stays available when the Manager resets an upgraded WebSocket", async () => {
    const manager = http.createServer();
    manager.on("upgrade", (_req, socket) => {
      trackSocket(socket);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "\r\n",
        () => socket.resetAndDestroy(),
      );
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl,
    });

    expect(await websocketUpgradeHeaders(uiPort, "/ws/events")).toContain(
      "HTTP/1.1 101 Switching Protocols",
    );
    await waitUntil(async () => (await fetch(uiOrigin)).status === 200);
  }, 15_000);

  it("stays available when the browser resets an upgraded WebSocket", async () => {
    const manager = http.createServer();
    manager.on("upgrade", (_req, socket) => {
      trackSocket(socket);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "\r\n",
      );
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl,
    });

    expect(await websocketUpgradeHeaders(uiPort, "/ws/events", true)).toContain(
      "HTTP/1.1 101 Switching Protocols",
    );
    await waitUntil(async () => (await fetch(uiOrigin)).status === 200);
  }, 15_000);

  it("proxies the dynamic Codex Live Voice WebSocket to the Manager unchanged", async () => {
    let upgradedPath = "";
    const manager = http.createServer();
    manager.on("upgrade", (req, socket) => {
      trackSocket(socket);
      upgradedPath = req.url || "";
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "\r\n",
      );
      socket.end();
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl,
    });

    // Dynamic sessionId path: the matcher must accept any non-empty id segment
    // and forward the path verbatim so Manager's Codex Live Voice handler keeps
    // ownership of the route.
    const sessionId = "01HK5CWD6YZ7EV1XBWG3V8N9P0";
    const livePath = `/api/voice-agent/sessions/${sessionId}/live`;
    const response = await websocketUpgrade(uiPort, livePath, uiOrigin);
    expect(response).toContain("HTTP/1.1 101 Switching Protocols");
    expect(upgradedPath).toBe(livePath);
  }, 15_000);

  it("destroys WebSocket upgrades on voice-agent routes outside the live allowlist", async () => {
    let managerUpgrades = 0;
    const manager = http.createServer();
    manager.on("upgrade", (_req, socket) => {
      // These paths must never reach Manager. If one does, track the socket so
      // afterEach tears it down instead of leaking it into the next test.
      trackSocket(socket);
      managerUpgrades++;
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl,
    });

    // Look-alike paths that must NOT be forwarded: an extra trailing segment, an
    // empty id, and a different voice-agent endpoint. The matcher is anchored, so
    // each of these should fall through to socket.destroy() and never reach Manager.
    // A destroyed upgrade closes the socket without a 101 Switching Protocols line.
    for (const badPath of [
      "/api/voice-agent/sessions/01HK5CWD6YZ7EV1XBWG3V8N9P0/live/extra",
      "/api/voice-agent/sessions//live",
      "/api/voice-agent/sessions/01HK5CWD6YZ7EV1XBWG3V8N9P0/ticket",
    ]) {
      const response = await websocketUpgrade(uiPort, badPath, uiOrigin).catch((reason) => String(reason));
      expect(response).not.toContain("HTTP/1.1 101 Switching Protocols");
    }
    expect(managerUpgrades).toBe(0);
  }, 15_000);

  it("rejects no-Origin/cross-origin requests and proxies exact self-Origin without credentials", async () => {
    const received: Array<{ authorization?: string; origin?: string; method?: string; mutationToken?: string }> = [];
    const manager = http.createServer((req, res) => {
      received.push({
        authorization: req.headers.authorization,
        origin: req.headers.origin,
        method: req.method,
        mutationToken: typeof req.headers["x-homerail-dag-token"] === "string"
          ? req.headers["x-homerail-dag-token"]
          : undefined,
      });
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl,
      mutationToken: "internal-mutation-token",
    });

    expect((await fetch(`${uiOrigin}/api/runs`, { method: "POST" })).status).toBe(403);
    expect((await fetch(`${uiOrigin}/api/runs`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    })).status).toBe(403);
    expect(received).toHaveLength(0);

    expect((await fetch(`${uiOrigin}/api/runs`, {
      method: "POST",
      headers: {
        Origin: uiOrigin,
        "x-homerail-dag-token": "browser-supplied-token",
      },
    })).status).toBe(200);
    expect(received[0]).toEqual({
      authorization: undefined,
      origin: uiOrigin,
      method: "POST",
      mutationToken: "internal-mutation-token",
    });

    expect((await fetch(`${uiOrigin}/api/read`)).status).toBe(200);
    expect(received[1]?.authorization).toBeUndefined();
    expect(received[1]?.mutationToken).toBeUndefined();
  }, 15_000);

  it("derives the self Origin for a publicly bound development server", async () => {
    let managerHits = 0;
    let receivedMutationToken: string | undefined;
    const manager = http.createServer((req, res) => {
      managerHits++;
      receivedMutationToken = typeof req.headers["x-homerail-dag-token"] === "string"
        ? req.headers["x-homerail-dag-token"]
        : undefined;
      req.resume();
      res.writeHead(200).end();
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort("0.0.0.0");
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({ port: uiPort, host: "0.0.0.0", origin: uiOrigin, managerUrl });

    const response = await fetch(`${uiOrigin}/api/runs`, {
      method: "POST",
      headers: {
        Origin: uiOrigin,
        "x-homerail-dag-token": "browser-supplied-token",
      },
    });
    expect(response.status).toBe(200);
    expect(managerHits).toBe(1);
    expect(receivedMutationToken).toBeUndefined();
  }, 15_000);

  it("rejects encoded traversal into a same-prefix sibling of the static root", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-static-ui-boundary-"));
    tempDirs.push(parent);
    const root = path.join(parent, "dist");
    const sibling = path.join(parent, "dist-secret");
    fs.mkdirSync(root);
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>test</title>");
    fs.writeFileSync(path.join(sibling, "secret.txt"), "must-not-be-served");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl: "http://127.0.0.1:1",
      root,
    });

    const response = await fetch(`${uiOrigin}/..%2fdist-secret/secret.txt`);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
  }, 15_000);

  it("returns 400 for malformed percent encoding and remains available", async () => {
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl: "http://127.0.0.1:1",
    });

    const malformed = await fetch(`${uiOrigin}/%`);
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("cache-control")).toBe("no-store");
    expect(await malformed.text()).toBe("bad request");

    const healthy = await fetch(`${uiOrigin}/`);
    expect(healthy.status).toBe(200);
    expect(await healthy.text()).toContain("<title>test</title>");
  }, 15_000);
});

async function startStaticUi(options: {
  port: number;
  host: string;
  origin: string;
  managerUrl: string;
  root?: string;
  mutationToken?: string;
  entry?: "source" | "dist";
}): Promise<void> {
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "homerail-static-ui-trust-"));
  if (!options.root) {
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>test</title>");
  }
  const args = options.entry === "dist"
    ? [path.resolve("dist/static-ui-server.js")]
    : [
        path.resolve("node_modules/tsx/dist/cli.mjs"),
        path.resolve("src/static-ui-server.ts"),
      ];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOMERAIL_STATIC_UI_DIR: root,
      HOMERAIL_UI_PORT: String(options.port),
      HOMERAIL_UI_HOST: options.host,
      HOMERAIL_UI_HTTPS: "0",
      HOMERAIL_MANAGER_HTTP: options.managerUrl,
      HOMERAIL_MANAGER_WS: options.managerUrl.replace(/^http/, "ws"),
      ...(options.mutationToken ? { HOMERAIL_DAG_MUTATION_TOKEN: options.mutationToken } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stderr = "";
  child.stdout?.resume();
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  await waitUntil(async () => {
    if (child.exitCode !== null) throw new Error(`static UI exited early: ${stderr}`);
    try {
      return (await fetch(options.origin)).status === 200;
    } catch {
      return false;
    }
  });
}

function buildPackagedUiArtifacts(): void {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("npm_execpath is required to build packaged UI test artifacts");
  for (const cwd of [process.cwd(), path.resolve("..", "agent-ui")]) {
    execFileSync(process.execPath, [npmCli, "run", "build"], {
      cwd,
      env: process.env,
      stdio: "pipe",
      timeout: 120_000,
    });
  }
}

async function listen(server: http.Server, host: string): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return `http://${host}:${address.port}`;
}

async function reservePort(host = "127.0.0.1"): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function websocketUpgrade(port: number, requestPath: string, origin?: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = trackSocket(net.createConnection({ host: "127.0.0.1", port }));
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("WebSocket upgrade timed out"));
    }, 5_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `GET ${requestPath} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        (origin ? `Origin: ${origin}\r\n` : "") +
        "\r\n",
      );
    });
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => {
      clearTimeout(timer);
      resolve(response);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function websocketUpgradeHeaders(
  port: number,
  requestPath: string,
  resetClient = false,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = trackSocket(net.createConnection({ host: "127.0.0.1", port }));
    let response = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      if (resetClient) socket.resetAndDestroy();
      resolve(response);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error("WebSocket upgrade timed out"));
    }, 5_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `GET ${requestPath} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "\r\n",
      );
    });
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\r\n\r\n")) finish();
    });
    socket.on("end", () => {
      if (!settled) finish(new Error("WebSocket ended before upgrade headers"));
    });
    socket.on("error", (error) => {
      if (!settled) finish(error);
    });
  });
}

function trackSocket(socket: net.Socket): net.Socket {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "ECONNRESET" && error.code !== "EPIPE") {
      unexpectedSocketErrors.push(error);
    }
  });
  return socket;
}

async function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const finish = (closed: boolean): void => {
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(closed);
    };
    const onClose = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onClose);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForChildClose(child, 5_000)) return;
  child.kill("SIGKILL");
  if (!await waitForChildClose(child, 2_000)) {
    throw new Error(`static UI child ${child.pid ?? "unknown"} did not exit`);
  }
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("static UI did not become ready");
}

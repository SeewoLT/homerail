import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CodexAppServerClient } from "../src/server/codex-appserver-client.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function writeFakeCodexAppServer(): { command: string; cwd: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "homerail codex appserver "));
  temporaryDirectories.push(cwd);
  const serverScript = path.join(cwd, "fake-codex-server.js");
  fs.writeFileSync(serverScript, [
    "let buffered = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    "  buffered += chunk;",
    "  for (;;) {",
    "    const newline = buffered.indexOf('\\n');",
    "    if (newline < 0) break;",
    "    const line = buffered.slice(0, newline).trim();",
    "    buffered = buffered.slice(newline + 1);",
    "    if (!line) continue;",
    "    const request = JSON.parse(line);",
    "    if (request.method === 'initialize') {",
    "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ready: true } }) + '\\n');",
    "    }",
    "  }",
    "});",
    "",
  ].join("\n"));

  if (process.platform === "win32") {
    const command = path.join(cwd, "codex.cmd");
    fs.writeFileSync(command, "@echo off\r\nnode \"%~dp0fake-codex-server.js\"\r\n");
    return { command, cwd };
  }

  const command = path.join(cwd, "codex");
  fs.writeFileSync(command, `#!/usr/bin/env node\nrequire(${JSON.stringify(serverScript)});\n`);
  fs.chmodSync(command, 0o755);
  return { command, cwd };
}

describe("CodexAppServerClient", () => {
  it("starts a Node-backed Codex shim from a path with spaces under a GUI-style minimal PATH", async () => {
    const fixture = writeFakeCodexAppServer();
    const minimalPath = process.platform === "win32"
      ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`
      : "/usr/bin:/bin";
    const client = new CodexAppServerClient({
      codexBin: fixture.command,
      cwd: fixture.cwd,
      env: { PATH: minimalPath },
      requestTimeoutMs: 2_000,
    });

    try {
      await client.start();
      await expect(client.initialize()).resolves.toMatchObject({ ready: true });
    } finally {
      client.close();
    }
  });
});

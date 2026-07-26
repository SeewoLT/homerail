import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  codexBinaryNotFoundMessage,
  codexCommandForSpawn,
  codexCommandEnvironment,
  resolveCodexBinary,
  resolveUsableCodexBinary,
  runCodexCommandSync,
  terminateCodexProcess,
} from "../src/server/codex-binary.js";

function fakeExistingFiles(
  files: string[],
  platform: "win32" | "posix" = "win32",
): (filePath: string) => boolean {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const normalized = new Set(files.map((filePath) => paths.normalize(filePath)));
  return (filePath: string) => normalized.has(paths.normalize(filePath));
}

describe("resolveCodexBinary", () => {
  it("resolves Windows npm cmd shims from an explicit path and marks them shell-backed", () => {
    const appData = "C:\\Users\\alice\\AppData\\Roaming";
    const requested = path.win32.join(appData, "npm", "codex");
    const shim = path.win32.join(appData, "npm", "codex.cmd");

    expect(resolveCodexBinary(requested, {
      platform: "win32",
      env: {},
      homeDir: "C:\\Users\\alice",
      fileExists: fakeExistingFiles([shim]),
    })).toEqual({
      command: shim,
      requested,
      needsShell: true,
    });
  });

  it("uses HOMERAIL_CODEX_BIN before CODEX_BIN_PATH", () => {
    const preferred = "/Users/alice/Custom Tools/codex";
    const fallback = "/fallback/codex";

    expect(resolveCodexBinary(undefined, {
      platform: "darwin",
      env: {
        HOMERAIL_CODEX_BIN: preferred,
        CODEX_BIN_PATH: fallback,
      },
      homeDir: "/Users/alice",
      fileExists: fakeExistingFiles([preferred, fallback], "posix"),
    })).toEqual({
      command: preferred,
      requested: preferred,
      needsShell: false,
    });
  });

  it("uses an explicit override before environment overrides and PATH", () => {
    const explicit = "/Users/alice/Explicit Tools/codex";
    const environment = "/Users/alice/Environment Tools/codex";
    const inherited = "/Users/alice/bin/codex";

    expect(resolveCodexBinary(explicit, {
      platform: "darwin",
      env: {
        HOMERAIL_CODEX_BIN: environment,
        CODEX_BIN_PATH: "/Users/alice/Fallback Tools/codex",
        PATH: "/Users/alice/bin:/usr/bin:/bin",
      },
      homeDir: "/Users/alice",
      fileExists: fakeExistingFiles([explicit, environment, inherited], "posix"),
    })?.command).toBe(explicit);
  });

  it("skips blank higher-priority overrides", () => {
    const fallback = "/Users/alice/Fallback Tools/codex";

    expect(resolveCodexBinary(undefined, {
      platform: "darwin",
      env: {
        HOMERAIL_CODEX_BIN: "   ",
        CODEX_BIN_PATH: fallback,
      },
      homeDir: "/Users/alice",
      fileExists: fakeExistingFiles([fallback], "posix"),
    })?.command).toBe(fallback);
  });

  it("uses an inherited PATH command before fallback installations", () => {
    const inherited = "/Users/alice/bin/codex";
    const homebrew = "/opt/homebrew/bin/codex";

    expect(resolveCodexBinary("codex", {
      platform: "darwin",
      env: { PATH: "/Users/alice/bin:/usr/bin:/bin" },
      homeDir: "/Users/alice",
      fileExists: fakeExistingFiles([inherited, homebrew], "posix"),
      readDirNames: () => [],
    })).toEqual({
      command: inherited,
      requested: "codex",
      needsShell: false,
    });
  });

  it("finds Homebrew Codex with a Finder-style minimal PATH", () => {
    const homebrew = "/opt/homebrew/bin/codex";

    expect(resolveCodexBinary("codex", {
      platform: "darwin",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      homeDir: "/Users/alice",
      fileExists: fakeExistingFiles([homebrew], "posix"),
      readDirNames: () => [],
    })).toEqual({
      command: homebrew,
      requested: "codex",
      needsShell: false,
    });
  });

  it("finds the newest nvm Codex install with a Finder-style minimal PATH", () => {
    const versionRoot = "/Users/Alice Smith/.nvm/versions/node";
    const codex = `${versionRoot}/v22.16.0/bin/codex`;

    expect(resolveCodexBinary("codex", {
      platform: "darwin",
      env: { PATH: "/usr/bin:/bin" },
      homeDir: "/Users/Alice Smith",
      fileExists: fakeExistingFiles([codex], "posix"),
      readDirNames: (directoryPath) => directoryPath === versionRoot
        ? ["v20.19.0", "v22.16.0"]
        : [],
    })).toEqual({
      command: codex,
      requested: "codex",
      needsShell: false,
    });
  });

  it("finds common user-local Codex installs outside the inherited PATH", () => {
    const localCodex = "/home/alice/.local/bin/codex";

    expect(resolveCodexBinary("codex", {
      platform: "linux",
      env: { PATH: "/usr/bin:/bin" },
      homeDir: "/home/alice",
      fileExists: fakeExistingFiles([localCodex], "posix"),
      readDirNames: () => [],
    })?.command).toBe(localCodex);
  });

  it("skips a non-executable POSIX PATH entry in favor of a later executable", () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-codex-executable-"));
    const staleDirectory = path.join(root, "stale");
    const validDirectory = path.join(root, "valid with spaces");
    fs.mkdirSync(staleDirectory);
    fs.mkdirSync(validDirectory);
    const stale = path.join(staleDirectory, "codex");
    const valid = path.join(validDirectory, "codex");
    fs.writeFileSync(stale, "#!/bin/sh\nexit 1\n");
    fs.writeFileSync(valid, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(stale, 0o644);
    fs.chmodSync(valid, 0o755);

    try {
      expect(resolveCodexBinary("codex", {
        platform: process.platform,
        env: { PATH: `${staleDirectory}${path.delimiter}${validDirectory}` },
        homeDir: root,
        readDirNames: () => [],
      })?.command).toBe(valid);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds Windows PATH executables with supported extensions", () => {
    const binDir = "C:\\Tools\\Codex";
    const exe = path.win32.join(binDir, "codex.exe");

    expect(resolveCodexBinary("codex", {
      platform: "win32",
      env: { PATH: binDir },
      homeDir: "C:\\Users\\alice",
      fileExists: fakeExistingFiles([exe]),
    })).toEqual({
      command: exe,
      requested: "codex",
      needsShell: false,
    });
  });

  it("honors the canonical Windows Path environment key", () => {
    const binDir = "C:\\Program Files\\Codex Tools";
    const exe = path.win32.join(binDir, "codex.exe");

    expect(resolveCodexBinary("codex", {
      platform: "win32",
      env: { Path: `${binDir};C:\\Windows\\System32` },
      homeDir: "C:\\Users\\alice",
      fileExists: fakeExistingFiles([exe]),
    })?.command).toBe(exe);
  });

  it("finds the Codex desktop app installation on Windows", () => {
    const localAppData = "C:\\Users\\alice\\AppData\\Local";
    const exe = path.win32.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe");

    expect(resolveCodexBinary("codex", {
      platform: "win32",
      env: { LOCALAPPDATA: localAppData },
      homeDir: "C:\\Users\\alice",
      fileExists: fakeExistingFiles([exe]),
    })).toEqual({
      command: exe,
      requested: "codex",
      needsShell: false,
    });
  });

  it("does not replace an explicit command name with a common Codex installation", () => {
    const localAppData = "C:\\Users\\alice\\AppData\\Local";
    const exe = path.win32.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe");

    expect(resolveCodexBinary("custom-codex", {
      platform: "win32",
      env: { LOCALAPPDATA: localAppData },
      homeDir: "C:\\Users\\alice",
      fileExists: fakeExistingFiles([exe]),
    })).toBeNull();
  });

  it("includes explicit missing paths in not-found messages", () => {
    expect(codexBinaryNotFoundMessage("/wrong/path/codex", {
      platform: "linux",
      env: {},
      homeDir: "/home/alice",
    })).toBe("Codex binary not found at: /wrong/path/codex. Install codex or set HOMERAIL_CODEX_BIN.");
  });

  it("redacts credentials and the home directory from missing-path diagnostics", () => {
    const message = codexBinaryNotFoundMessage(
      "/Users/alice/Tools/sk-supersecret123/codex",
      {
        platform: "darwin",
        env: {
          OPENAI_API_KEY: "sk-environment-secret123",
          HOMERAIL_CODEX_BIN: "/Users/alice/Tools/sk-supersecret123/codex",
        },
        homeDir: "/Users/alice",
      },
    );

    expect(message).toContain("~/Tools/[REDACTED]/codex");
    expect(message).not.toContain("supersecret");
    expect(message).not.toContain("environment-secret");
  });

  it("prepends the Codex and current Node directories to a minimal child PATH", () => {
    const env = codexCommandEnvironment(
      "/opt/homebrew/bin/codex",
      {
        PATH: "/usr/bin:/bin",
        OPENAI_API_KEY: "sk-do-not-log-this-value",
      },
      {
        platform: "darwin",
        nodeExecPath: "/Applications/HomeRail.app/Contents/Resources/node-bin/node",
      },
    );

    expect(env.PATH).toBe(
      "/opt/homebrew/bin:/Applications/HomeRail.app/Contents/Resources/node-bin:/usr/bin:/bin",
    );
    expect(env.OPENAI_API_KEY).toBe("sk-do-not-log-this-value");
  });

  it("merges every Windows PATH key before normalizing its casing", () => {
    const env = codexCommandEnvironment(
      "C:\\Users\\Alice\\AppData\\Roaming\\npm\\codex.cmd",
      {
        PATH: "C:\\Windows\\System32",
        Path: "C:\\Users\\Alice\\bin;C:\\Windows\\System32",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      },
      {
        platform: "win32",
        nodeExecPath: "C:\\Program Files\\HomeRail\\node.exe",
      },
    );

    expect(env.PATH).toBe(
      "C:\\Users\\Alice\\AppData\\Roaming\\npm;C:\\Program Files\\HomeRail;C:\\Windows\\System32;C:\\Users\\Alice\\bin",
    );
    expect(env.Path).toBeUndefined();
    expect(env.PATHEXT).toBe(".COM;.EXE;.BAT;.CMD");
  });

  it("returns a failed result instead of throwing when spawnSync throws", () => {
    const error = new Error("spawn exploded");
    let spawnOptions: Record<string, unknown> | undefined;
    const result = runCodexCommandSync("C:\\Tools\\codex.cmd", ["--version"], {
      platform: "win32",
      env: {},
      spawnSyncImpl: ((_command, _args, options) => {
        spawnOptions = options as Record<string, unknown>;
        throw error;
      }) as typeof import("node:child_process").spawnSync,
    });

    expect(result.status).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("spawn exploded");
    expect(result.error).toBe(error);
    expect(spawnOptions).toMatchObject({
      shell: true,
      windowsHide: true,
    });
  });

  it("uses the enriched PATH when probing a Codex shim whose path contains spaces", () => {
    const command = "/Users/Alice Smith/.nvm/versions/node/v22/bin/codex";
    let spawnCommand = "";
    let spawnOptions: Record<string, unknown> | undefined;
    const result = runCodexCommandSync(command, ["--version"], {
      platform: "darwin",
      env: { PATH: "/usr/bin:/bin" },
      nodeExecPath: "/Applications/HomeRail.app/Contents/Resources/node-bin/node",
      spawnSyncImpl: ((actualCommand, _args, options) => {
        spawnCommand = actualCommand;
        spawnOptions = options as Record<string, unknown>;
        return {
          pid: 1,
          output: [null, "codex-cli 0.145.0\n", ""],
          stdout: "codex-cli 0.145.0\n",
          stderr: "",
          status: 0,
          signal: null,
        };
      }) as typeof import("node:child_process").spawnSync,
    });

    expect(result.status).toBe(0);
    expect(spawnCommand).toBe(command);
    expect(spawnOptions).toMatchObject({
      shell: false,
      env: expect.objectContaining({
        PATH: `${path.posix.dirname(command)}:/Applications/HomeRail.app/Contents/Resources/node-bin:/usr/bin:/bin`,
      }),
    });
  });

  it("quotes a shell-backed Windows shim path before spawning it", () => {
    const command = "C:\\Users\\Alice Smith\\AppData\\Roaming\\npm\\codex.cmd";

    expect(codexCommandForSpawn(command, "win32")).toBe(`"${command}"`);
    expect(codexCommandForSpawn("C:\\Tools\\codex.cmd", "win32"))
      .toBe("C:\\Tools\\codex.cmd");
    expect(codexCommandForSpawn("/Users/Alice Smith/bin/codex", "darwin"))
      .toBe("/Users/Alice Smith/bin/codex");
  });

  it("rejects shell-backed Windows shim paths with command metacharacters", () => {
    const command = "C:\\Users\\Alice & Bob\\AppData\\Roaming\\npm\\codex.cmd";

    expect(() => codexCommandForSpawn(command, "win32"))
      .toThrowError("Codex Windows shim path contains unsupported shell metacharacters");
    expect(resolveCodexBinary(command, {
      platform: "win32",
      env: {},
      homeDir: "C:\\Users\\Alice & Bob",
      fileExists: fakeExistingFiles([command], "win32"),
      readDirNames: () => [],
    })).toBeNull();
    expect(codexBinaryNotFoundMessage(command, {
      platform: "win32",
      env: {},
      homeDir: "C:\\Users\\Alice & Bob",
    })).toBe(
      "Codex Windows shim path contains unsupported shell metacharacters. Choose a different install path or set HOMERAIL_CODEX_BIN.",
    );
  });

  it("terminates the full process tree for a shell-backed Windows shim", () => {
    const taskkillCalls: Array<{
      command: string;
      args: string[];
      options: Record<string, unknown> | undefined;
    }> = [];
    let directKillCalled = false;
    const child = {
      pid: 321,
      killed: false,
      kill: () => {
        directKillCalled = true;
        return true;
      },
    } as unknown as ChildProcess;

    terminateCodexProcess(child, true, {
      platform: "win32",
      spawnSyncImpl: ((command, args, options) => {
        taskkillCalls.push({
          command,
          args: args ?? [],
          options: options as Record<string, unknown> | undefined,
        });
        return {
          pid: 1,
          output: [null, null, null],
          stdout: null,
          stderr: null,
          status: 0,
          signal: null,
        };
      }) as typeof import("node:child_process").spawnSync,
    });

    expect(taskkillCalls).toEqual([{
      command: "taskkill.exe",
      args: ["/pid", "321", "/T", "/F"],
      options: {
        stdio: "ignore",
        timeout: 5_000,
        windowsHide: true,
      },
    }]);
    expect(directKillCalled).toBe(false);
  });

  it("falls back to a direct signal when Windows tree termination fails", () => {
    const directKillCalls: string[] = [];
    const child = {
      pid: 654,
      killed: false,
      kill: (signal: string) => {
        directKillCalls.push(signal);
        return true;
      },
    } as unknown as ChildProcess;

    terminateCodexProcess(child, true, {
      platform: "win32",
      spawnSyncImpl: (() => ({
        pid: 1,
        output: [null, null, null],
        stdout: null,
        stderr: null,
        status: null,
        signal: null,
      })) as typeof import("node:child_process").spawnSync,
    });

    expect(directKillCalls).toEqual(["SIGTERM"]);
  });
});

describe("resolveUsableCodexBinary", () => {
  it("skips an unusable default PATH candidate and selects a later working install", () => {
    const stale = "/Users/alice/stale/codex";
    const homebrew = "/opt/homebrew/bin/codex";
    const attempted: string[] = [];

    const resolution = resolveUsableCodexBinary("codex", {
      platform: "darwin",
      env: { PATH: "/Users/alice/stale:/usr/bin:/bin" },
      homeDir: "/Users/alice",
      fileExists: fakeExistingFiles([stale, homebrew], "posix"),
      readDirNames: () => [],
      runCommand: (command, args) => {
        attempted.push(`${command} ${args.join(" ")}`);
        return {
          status: command === homebrew ? 0 : 1,
          stdout: command === homebrew ? "codex-cli 0.145.0\n" : "",
        };
      },
    });
    expect(resolution?.command).toBe(homebrew);
    expect(resolution?.probe).toEqual({
      status: 0,
      stdout: "codex-cli 0.145.0\n",
    });
    expect(attempted).toEqual([
      `${stale} --version`,
      `${homebrew} --version`,
    ]);
  });

  it("does not bypass an unusable explicit override", () => {
    const explicit = "/Users/alice/custom/codex";
    const homebrew = "/opt/homebrew/bin/codex";
    const attempted: string[] = [];

    expect(resolveUsableCodexBinary(undefined, {
      platform: "darwin",
      env: {
        HOMERAIL_CODEX_BIN: explicit,
        PATH: "/usr/bin:/bin",
      },
      homeDir: "/Users/alice",
      fileExists: fakeExistingFiles([explicit, homebrew], "posix"),
      readDirNames: () => [],
      runCommand: (command) => {
        attempted.push(command);
        return { status: command === homebrew ? 0 : 1 };
      },
    })?.command).toBe(explicit);
    expect(attempted).toEqual([]);
  });

  it("retains the failed probe when every default candidate is unusable", () => {
    const stale = "/Users/alice/stale/codex";
    const homebrew = "/opt/homebrew/bin/codex";
    const attempted: string[] = [];

    const resolution = resolveUsableCodexBinary("codex", {
      platform: "darwin",
      env: { PATH: "/Users/alice/stale:/usr/bin:/bin" },
      homeDir: "/Users/alice",
      fileExists: fakeExistingFiles([stale, homebrew], "posix"),
      readDirNames: () => [],
      runCommand: (command) => {
        attempted.push(command);
        return {
          status: 1,
          stdout: command === stale ? "stale failure\n" : "brew failure\n",
        };
      },
    });

    expect(resolution).toMatchObject({
      command: stale,
      probe: {
        status: 1,
        stdout: "stale failure\n",
      },
    });
    expect(attempted).toEqual([stale, homebrew]);
  });
});

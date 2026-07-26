import type { SpawnSyncReturns } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _clearCodexLiveVoiceCapabilityCacheForTest,
  codexAuthenticationPresent,
  inspectCodexInstallation,
} from "../src/server/codex-live-voice-capability.js";

function result(status: number, stdout = "", stderr = ""): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status,
    signal: null,
  };
}

function inspect(version: string, features: string) {
  const runCommand = vi.fn((_command: string, args: string[]) => (
    args[0] === "--version" ? result(0, `${version}\n`) : result(0, features)
  ));
  const installation = inspectCodexInstallation({
    requested: "/test/codex",
    resolveBinary: () => ({
      command: "/test/codex",
      requested: "/test/codex",
      needsShell: false,
    }),
    runCommand,
    authPresent: () => true,
    statMtimeMs: () => 42,
  });
  return { installation, runCommand };
}

beforeEach(() => {
  _clearCodexLiveVoiceCapabilityCacheForTest();
});

describe("inspectCodexInstallation", () => {
  it("reports a missing binary without probing features", () => {
    const installation = inspectCodexInstallation({
      requested: "codex",
      resolveBinary: () => null,
      authPresent: () => false,
    });

    expect(installation).toMatchObject({
      available: false,
      logged_in: false,
      binary: "codex",
      live_voice: {
        supported: false,
        minimum_version: "0.145.0",
        reason: "missing",
      },
    });
    expect(installation.diagnostics.map((item) => item.code)).toEqual([
      "codex_binary_not_found",
      "codex_auth_missing",
    ]);
  });

  it("distinguishes a found but unusable binary from a missing binary", () => {
    const installation = inspectCodexInstallation({
      requested: "/Applications/Codex Tools/codex",
      resolveBinary: () => ({
        command: "/Applications/Codex Tools/codex",
        requested: "/Applications/Codex Tools/codex",
        needsShell: false,
      }),
      runCommand: () => result(127, "", "env: node: No such file or directory"),
      authPresent: () => true,
    });

    expect(installation).toMatchObject({
      available: false,
      logged_in: true,
      live_voice: {
        supported: false,
        reason: "unusable",
      },
      diagnostics: [{
        code: "codex_binary_unusable",
        message: "Codex CLI was found but could not be executed.",
      }],
    });
  });

  it("rejects an unparseable version", () => {
    const { installation, runCommand } = inspect(
      "custom-codex development",
      "realtime_conversation under development false\n",
    );

    expect(installation.live_voice).toMatchObject({
      supported: false,
      reason: "unparseable",
    });
    expect(installation.diagnostics).toContainEqual(expect.objectContaining({
      code: "codex_version_unparseable",
    }));
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("rejects Codex versions before 0.145.0", () => {
    const { installation, runCommand } = inspect(
      "codex-cli 0.144.9",
      "realtime_conversation under development false\n",
    );

    expect(installation).toMatchObject({
      available: true,
      semantic_version: "0.144.9",
      live_voice: {
        supported: false,
        reason: "too_old",
      },
    });
    expect(installation.diagnostics).toContainEqual(expect.objectContaining({
      code: "codex_version_too_old",
    }));
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("treats a 0.145.0 prerelease as older than the stable minimum", () => {
    const { installation, runCommand } = inspect(
      "codex-cli 0.145.0-beta.1",
      "realtime_conversation under development false\n",
    );

    expect(installation).toMatchObject({
      semantic_version: "0.145.0-beta.1",
      live_voice: {
        supported: false,
        reason: "too_old",
      },
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("accepts 0.145.0 when the experimental feature is present but disabled", () => {
    const { installation } = inspect(
      "codex-cli 0.145.0",
      "realtime_conversation under development false\nremote_control removed false\n",
    );

    expect(installation).toMatchObject({
      semantic_version: "0.145.0",
      live_voice: {
        supported: true,
        protocol: "v3",
        transport: "webrtc",
        feature: "realtime_conversation",
        voices: ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"],
        default_voice: "cove",
        stage: "under development",
      },
    });
  });

  it("rejects a missing or removed feature on a newer version", () => {
    const { installation } = inspect(
      "codex-cli 0.200.1",
      "realtime_conversation removed false\n",
    );

    expect(installation.live_voice).toMatchObject({
      supported: false,
      stage: "removed",
      reason: "feature_missing",
    });
    expect(installation.diagnostics).toContainEqual(expect.objectContaining({
      code: "codex_live_voice_feature_missing",
    }));
  });

  it("caches the feature probe for the same binary build", () => {
    const first = inspect(
      "codex-cli 0.145.0",
      "realtime_conversation under development false\n",
    );
    const second = inspect(
      "codex-cli 0.145.0",
      "realtime_conversation under development false\n",
    );

    expect(first.runCommand).toHaveBeenCalledTimes(2);
    expect(second.runCommand).toHaveBeenCalledTimes(1);
    expect(second.installation.live_voice.supported).toBe(true);
  });

  it("reports missing authentication separately from version and feature capability", () => {
    const runCommand = vi.fn((_command: string, args: string[]) => (
      args[0] === "--version"
        ? result(0, "codex-cli 0.145.0\n")
        : result(0, "realtime_conversation under development false\n")
    ));
    const installation = inspectCodexInstallation({
      requested: "/test/codex",
      resolveBinary: () => ({
        command: "/test/codex",
        requested: "/test/codex",
        needsShell: false,
      }),
      runCommand,
      authPresent: () => false,
      statMtimeMs: () => 42,
    });

    expect(installation).toMatchObject({
      available: true,
      logged_in: false,
      live_voice: { supported: true },
      diagnostics: [{
        code: "codex_auth_missing",
        message: "Codex credentials were not found for this user.",
      }],
    });
  });

  it("accepts either an API key or a non-empty Codex auth file without exposing it", () => {
    expect(codexAuthenticationPresent({
      env: { OPENAI_API_KEY: "sk-private-test-token" },
      homeDir: "/Users/alice",
      readAuthFile: () => {
        throw new Error("should not read auth file");
      },
    })).toBe(true);
    expect(codexAuthenticationPresent({
      env: {},
      homeDir: "/Users/alice",
      readAuthFile: () => "{\"tokens\":{\"access_token\":\"private\"}}",
    })).toBe(true);
  });

  it("redacts token-like version output and never includes stderr or environment secrets", () => {
    const installation = inspectCodexInstallation({
      requested: "/Users/alice/sk-path-secret123/codex",
      env: { OPENAI_API_KEY: "sk-environment-secret123" },
      homeDir: "/Users/alice",
      resolveBinary: () => ({
        command: "/Users/alice/sk-path-secret123/codex",
        requested: "/Users/alice/sk-path-secret123/codex",
        needsShell: false,
      }),
      runCommand: () => result(
        0,
        "custom-codex sk-stdout-secret123\n",
        "Bearer stderr-secret-token",
      ),
      authPresent: () => true,
    });

    const serialized = JSON.stringify(installation);
    expect(installation.binary).toBe("~/[REDACTED]/codex");
    expect(installation.version).toBeUndefined();
    expect(serialized).not.toContain("path-secret");
    expect(serialized).not.toContain("stdout-secret");
    expect(serialized).not.toContain("stderr-secret");
    expect(serialized).not.toContain("environment-secret");
    expect(installation.diagnostics).toContainEqual(expect.objectContaining({
      code: "codex_version_unparseable",
    }));
  });

  it("does not expose unrecognized feature-stage output", () => {
    const { installation } = inspect(
      "codex-cli 0.145.0",
      "realtime_conversation private-stage-value false\n",
    );

    expect(installation.live_voice).toMatchObject({
      supported: true,
      feature: "realtime_conversation",
    });
    expect(installation.live_voice.stage).toBeUndefined();
    expect(JSON.stringify(installation)).not.toContain("private-stage-value");
  });
});

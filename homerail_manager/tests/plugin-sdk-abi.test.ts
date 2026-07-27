import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomerailPluginManifestV1 } from "homerail-protocol";

vi.mock("homerail-plugin-sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("homerail-plugin-sdk")>();
  return {
    ...original,
    validatePluginSkill: vi.fn().mockReturnValue(undefined),
  };
});

import { loadPluginPackage } from "../src/plugins/manifest-loader.js";
import { HOMERAIL_PLUGIN_SDK_ABI_VERSION } from "homerail-plugin-sdk";

function writeMinimalPlugin(root: string, id = "com.example.abi", version = "1.0.0"): string {
  const packageRoot = path.join(root, `${id}-${version}`);
  fs.mkdirSync(path.join(packageRoot, "skills", "abi"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "schemas"), { recursive: true });
  const manifest: HomerailPluginManifestV1 = {
    manifest_version: 1,
    id,
    version,
    name: "ABI Test",
    publisher: { id: "com.example", name: "Example" },
    license: "MIT",
    compatibility: {
      homerail: { min: "0.1.0", max_exclusive: "0.2.0" },
      plugin_api: [1], ui_ir: [1], renderer_api: [1],
    },
    capabilities: [{
      id: "abi", summary: "ABI test.", intents: ["test abi"],
      modalities: ["text"], required_inputs: [], skill: "abi",
      tools: [], workflows: [], actions: [],
    }],
    skills: [{ id: "abi", path: "skills/abi/SKILL.md", description: "ABI test skill." }],
    schemas: [{ id: "abi-v1", file: "schemas/abi.v1.schema.json" }],
    kinds: [], tools: [], workflows: [], renderers: [], actions: [],
    runtime: { trust: "data_only", plugin_api: 1 },
    permissions: { required: [], optional: [] },
    state: { schema_version: 1, migrations: [] },
  };
  fs.writeFileSync(path.join(packageRoot, "homerail.plugin.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(packageRoot, "skills", "abi", "SKILL.md"), [
    "---", "name: abi", "description: ABI test skill.", "---", "", "# ABI Test", "", "Test body.", "",
  ].join("\n"));
  fs.writeFileSync(path.join(packageRoot, "schemas", "abi.v1.schema.json"), JSON.stringify({
    type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false,
  }, null, 2));
  return packageRoot;
}

describe("plugin SDK ABI guard", () => {
  let tmpHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-sdk-abi-"));
    process.env.HOMERAIL_HOME = tmpHome;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("exports HOMERAIL_PLUGIN_SDK_ABI_VERSION from the SDK", () => {
    expect(HOMERAIL_PLUGIN_SDK_ABI_VERSION).toBe(1);
  });

  it("throws a clear ABI mismatch error when validatePluginSkill returns undefined (stale dist)", () => {
    const packageRoot = writeMinimalPlugin(tmpHome);
    expect(() => loadPluginPackage(packageRoot, { source: "development" })).toThrow(
      /ABI mismatch/,
    );
    expect(() => loadPluginPackage(packageRoot, { source: "development" })).toThrow(
      /rebuild homerail_plugin_sdk/i,
    );
  });
});

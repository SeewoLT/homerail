#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  autoFixV2RuntimeProfileYaml,
  selectAutoFixV2Setting,
} from "./configure-auto-fix-v2-runtime-profile.mjs";

const setting = (id, model, endpoint) => ({
  id,
  display_name: model,
  model_name: model,
  is_active: 1,
  supports_llm: 1,
  ...endpoint,
});

const settings = [
  setting("k3", "Kimi K3", { base_url: "https://kimi.example/v1" }),
  setting("deepseek-v4-flash", "DeepSeek V4 Flash", { anthropic_base_url: "https://models.example/v1" }),
  setting("glm-5-2", "GLM-5.2", { anthropic_base_url: "https://models.example/v1" }),
];
const analyzer = selectAutoFixV2Setting(settings, "k3", "analyzer");
const implementation = selectAutoFixV2Setting(settings, "deepseek-v4-flash", "implementation");
const review = selectAutoFixV2Setting(settings, "glm-5-2", "review");
const yaml = autoFixV2RuntimeProfileYaml({ profileId: "pilot", analyzer, implementation, review });

assert.match(yaml, /workflow_id: auto-fix-v2/);
assert.match(yaml, /analyzer:\n    llm_setting_id: "k3"\n    agent_type: kimi_code/);
for (const id of ["implementer", "aggregator", "fixer"]) {
  assert.match(yaml, new RegExp(`${id}:\\n    llm_setting_id: "deepseek-v4-flash"`));
}
assert.match(yaml, /reviewer:\n    llm_setting_id: "glm-5-2"/);
assert.throws(() => selectAutoFixV2Setting(settings, "glm-5-2", "analyzer"), /required model family/);

process.stdout.write("auto-fix-v2 runtime profile tests passed\n");

#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const ROLE_PATTERNS = Object.freeze({
  analyzer: /(?:^|[-_. /])k3(?:$|[-_. /])/i,
  implementation: /deepseek.*v4.*flash|v4.*flash.*deepseek/i,
  review: /glm[-_. /]*5(?:[-_. /]*2|\.2)/i,
});

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function enabled(value) {
  return value === true || value === 1;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

export function selectAutoFixV2Setting(settings, selector, role) {
  const wanted = text(selector);
  if (!wanted) throw new Error(`HOMERAIL_AUTO_FIX_V2_${role.toUpperCase()}_MODEL is required`);
  const matches = settings.filter((setting) => (
    setting?.id === wanted || setting?.display_name === wanted || setting?.model_name === wanted
  ));
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `Auto Fix v2 ${role} model was not found: ${wanted}`
      : `Auto Fix v2 ${role} model selector is ambiguous: ${wanted}`);
  }
  const setting = matches[0];
  const identity = [setting.id, setting.display_name, setting.model_name].filter(Boolean).join(" ");
  if (!ROLE_PATTERNS[role]?.test(identity)) {
    throw new Error(`Auto Fix v2 ${role} selector does not identify the required model family: ${identity}`);
  }
  if (!enabled(setting.is_active) || !enabled(setting.supports_llm)) {
    throw new Error(`Auto Fix v2 ${role} model is not an active LLM setting: ${wanted}`);
  }
  const hasKimiCodeEndpoint = Boolean(
    text(setting.base_url)
    || text(setting.provider_base_url)
    || text(setting.chat_completions_base_url),
  );
  if (role === "analyzer" && !hasKimiCodeEndpoint) {
    throw new Error(`Auto Fix v2 analyzer model has no Kimi Code-compatible endpoint: ${wanted}`);
  }
  if (role !== "analyzer" && !text(setting.anthropic_base_url)) {
    throw new Error(`Auto Fix v2 ${role} model has no Anthropic-compatible endpoint: ${wanted}`);
  }
  return setting;
}

function agentEntry(id, setting, agentType) {
  return [
    `  ${id}:`,
    `    llm_setting_id: ${yamlString(setting.id)}`,
    `    agent_type: ${agentType}`,
  ];
}

export function autoFixV2RuntimeProfileYaml({ profileId, analyzer, implementation, review }) {
  return [
    `profile_id: ${yamlString(profileId)}`,
    "workflow_id: auto-fix-v2",
    "description: K3 analysis, DeepSeek V4 Flash implementation/fix/aggregation, and fresh GLM-5.2 review.",
    "agents:",
    ...agentEntry("analyzer", analyzer, "kimi_code"),
    ...agentEntry("implementer", implementation, "claude-sdk"),
    ...agentEntry("aggregator", implementation, "claude-sdk"),
    ...agentEntry("fixer", implementation, "claude-sdk"),
    ...agentEntry("reviewer", review, "claude-sdk"),
    "",
  ].join("\n");
}

async function request(managerUrl, pathname, init) {
  const response = await fetch(`${managerUrl}${pathname}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(init?.method && init.method !== "GET" && process.env.HOMERAIL_DAG_MUTATION_TOKEN
        ? { "x-homerail-dag-token": process.env.HOMERAIL_DAG_MUTATION_TOKEN }
        : {}),
    },
  });
  const body = await response.json();
  if (!response.ok || body.success === false) {
    throw new Error(`${init?.method ?? "GET"} ${pathname}: ${body.error ?? body.message ?? `HTTP ${response.status}`}`);
  }
  return body.data;
}

export async function configureAutoFixV2RuntimeProfile({
  managerUrl = process.env.HOMERAIL_MANAGER_URL ?? "http://127.0.0.1:19191",
  profileId = process.env.HOMERAIL_AUTO_FIX_V2_PROFILE_ID ?? "auto-fix-v2-mixed",
  analyzerSelector = process.env.HOMERAIL_AUTO_FIX_V2_ANALYZER_MODEL,
  implementationSelector = process.env.HOMERAIL_AUTO_FIX_V2_IMPLEMENTATION_MODEL,
  reviewSelector = process.env.HOMERAIL_AUTO_FIX_V2_REVIEW_MODEL,
} = {}) {
  const root = managerUrl.replace(/\/+$/, "");
  const listed = await request(root, "/api/llm/settings");
  const settings = Array.isArray(listed?.settings) ? listed.settings : [];
  const analyzer = selectAutoFixV2Setting(settings, analyzerSelector, "analyzer");
  const implementation = selectAutoFixV2Setting(settings, implementationSelector, "implementation");
  const review = selectAutoFixV2Setting(settings, reviewSelector, "review");
  const yamlText = autoFixV2RuntimeProfileYaml({ profileId, analyzer, implementation, review });
  const synced = await request(root, "/api/dag/profiles/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      yaml_text: yamlText,
      workflow_id: "auto-fix-v2",
      source_path: "stable-runner:auto-fix-v2-mixed",
    }),
  });
  if (synced?.profile?.profile_id !== profileId || synced?.profile?.workflow_id !== "auto-fix-v2") {
    throw new Error("Manager synced an unexpected Auto Fix v2 runtime profile");
  }
  return { profileId, analyzer, implementation, review, yamlText };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const configured = await configureAutoFixV2RuntimeProfile();
    process.stdout.write(configured.profileId);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

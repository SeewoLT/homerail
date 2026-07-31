import { describe, expect, it } from "vitest";
import {
  dagNodeTokenTotal,
  normalizeDagNodeExecutionIdentity,
} from "../src/dag-observability.js";

describe("DAG node observability", () => {
  it("uses one documented total across every token category", () => {
    expect(dagNodeTokenTotal({
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 6,
      cache_creation_input_tokens: 2,
    })).toBe(22);
  });

  it("whitelists execution identity without leaking endpoint or credential fields", () => {
    const identity = normalizeDagNodeExecutionIdentity({
      provider_id: "anthropic",
      provider_display_name: "Anthropic",
      model_name: "claude-sonnet",
      model_display_name: "Claude Sonnet",
      agent_backend: "claude-sdk",
      protocol: "anthropic_compatible",
      context_limit: 200_000,
      context_usage_pct: 12.5,
      api_key: "sk-private-value-123456",
      base_url: "https://private.example.test",
      authorization: "Bearer private-value",
    });

    expect(identity).toEqual({
      provider_id: "anthropic",
      provider_display_name: "Anthropic",
      model_name: "claude-sonnet",
      model_display_name: "Claude Sonnet",
      agent_backend: "claude-sdk",
      protocol: "anthropic_compatible",
      context_limit: 200_000,
      context_usage_pct: 12.5,
    });
    expect(JSON.stringify(identity)).not.toContain("private");
  });

  it("treats missing or secret-looking identity as unavailable", () => {
    expect(normalizeDagNodeExecutionIdentity({
      model_name: "sk-secretvalue123456",
      context_limit: -1,
    })).toBeUndefined();
  });
});

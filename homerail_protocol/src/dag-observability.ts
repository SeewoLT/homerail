/**
 * Safe DAG node execution identity and token observability contract.
 * @version 0.1.0
 */

import { redactTelemetry } from "./telemetry-redaction.js";

/** Token categories reported by a model-backed DAG node. */
export interface DagNodeTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/**
 * Trusted, non-secret identity of the runtime that executed a DAG node.
 *
 * Endpoint URLs, setting IDs, credentials, and transport headers are
 * intentionally absent from this contract.
 */
export interface DagNodeExecutionIdentity {
  provider_id?: string;
  provider_display_name?: string;
  model_name?: string;
  model_display_name?: string;
  agent_backend?: string;
  protocol?: string;
  context_limit?: number;
  context_usage_pct?: number;
}

/** One authoritative Worker turn within a potentially multi-round node. */
export interface DagNodeUsageScope {
  session_id?: string;
  round_id?: string;
  generation?: number;
  command_id?: string;
}

export const DAG_NODE_USAGE_AGGREGATION = "node_cumulative" as const;

function boundedIdentityString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const redacted = String(redactTelemetry(value)).trim();
  if (!redacted || redacted === "***REDACTED***") return undefined;
  return redacted.slice(0, 256);
}

function nonNegativeNumber(value: unknown, integer = false): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return integer ? Math.floor(value) : value;
}

/**
 * Whitelist and bound the only execution identity fields that may cross the
 * Manager metrics boundary.
 */
export function normalizeDagNodeExecutionIdentity(
  value: unknown,
): DagNodeExecutionIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const normalized: DagNodeExecutionIdentity = {
    provider_id: boundedIdentityString(source.provider_id),
    provider_display_name: boundedIdentityString(source.provider_display_name),
    model_name: boundedIdentityString(source.model_name),
    model_display_name: boundedIdentityString(source.model_display_name),
    agent_backend: boundedIdentityString(source.agent_backend),
    protocol: boundedIdentityString(source.protocol),
    context_limit: nonNegativeNumber(source.context_limit, true),
    context_usage_pct: nonNegativeNumber(source.context_usage_pct),
  };
  for (const key of Object.keys(normalized) as Array<keyof DagNodeExecutionIdentity>) {
    if (normalized[key] === undefined) delete normalized[key];
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/**
 * Total processed tokens. Cache reads and cache creations are separate input
 * categories, so the total is the sum of all four authoritative counters.
 */
export function dagNodeTokenTotal(usage: Partial<DagNodeTokenUsage>): number {
  return tokenCount(usage.input_tokens)
    + tokenCount(usage.output_tokens)
    + tokenCount(usage.cache_read_input_tokens)
    + tokenCount(usage.cache_creation_input_tokens);
}

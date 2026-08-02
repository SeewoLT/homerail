import { createHash, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  dagRunInputPath,
  listDagRunInputs,
} from "../persistence/run-input-artifacts.js";
import {
  getActiveRun,
  getActiveRunBrokerState,
  setActiveRunBrokerState,
} from "./active-runs.js";
import type { CredentialBrokerContext } from "./credential-broker.js";
import { runWorkspacePath } from "./workspace-retention.js";

interface GithubPullRequestContext {
  version: 1;
  owner: string;
  repo: string;
  pull_number: number;
  clone_url: string;
  head_ref: string;
  base_ref: string;
  initial_head_sha: string;
  base_sha: string;
  task_document_sha256: string;
  require_draft: boolean;
  writable_paths: string[];
  required_checks: string[];
  validation_workflow?: {
    workflow_id: string;
    inputs: Record<string, string>;
  };
}

interface GithubPullRequestState {
  version: 1;
  identity: string;
  current_head_sha: string;
  pending_head_sha?: string;
}

interface PullResponse {
  number?: number;
  title?: string;
  body?: string | null;
  draft?: boolean;
  state?: string;
  html_url?: string;
  head?: { sha?: string; ref?: string; label?: string; repo?: { full_name?: string } | null };
  base?: { sha?: string; ref?: string; label?: string; repo?: { full_name?: string } | null };
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const OWNER_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_COMMIT_FILES = 64;
const MAX_COMMIT_BYTES = 1024 * 1024;
const MAX_READ_FILE_BYTES = 192 * 1024;
const MAX_READ_FILE_JSON_BYTES = 224 * 1024;
const MAX_PATCH_CHARS = 8_000;
const VALIDATION_POLL_INTERVAL_MS = 5_000;
const VALIDATION_TIMEOUT_MS = 45 * 60_000;

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function safeRelativePath(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !raw || raw.includes("\\") || raw.startsWith("/") || raw.includes("\0")) {
    throw new Error(`${label} is not a safe repository path`);
  }
  const segments = raw.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || !SAFE_PATH_SEGMENT.test(segment))) {
    throw new Error(`${label} is not a safe repository path`);
  }
  return segments.join("/");
}

function parsePullRequestContext(runId: string): GithubPullRequestContext {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(dagRunInputPath(runId, "pr_context"), "utf8")) as unknown;
  } catch {
    throw new Error("The run has no valid immutable pr_context input");
  }
  const raw = jsonRecord(value, "pr_context");
  const owner = String(raw.owner ?? "");
  const repo = String(raw.repo ?? "");
  const pullNumber = Number(raw.pull_number);
  const cloneUrl = String(raw.clone_url ?? "");
  const headRef = String(raw.head_ref ?? "");
  const baseRef = String(raw.base_ref ?? raw.base_branch ?? "");
  const initialHeadSha = String(raw.initial_head_sha ?? raw.head_sha ?? "").toLowerCase();
  const baseSha = String(raw.base_sha ?? "").toLowerCase();
  const taskDocumentSha256 = String(raw.task_document_sha256 ?? "").toLowerCase();
  if (raw.version !== 1 || !OWNER_REPO.test(owner) || !OWNER_REPO.test(repo)) {
    throw new Error("pr_context repository identity is invalid");
  }
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) throw new Error("pr_context pull_number is invalid");
  if (cloneUrl !== `https://github.com/${owner}/${repo}.git`) {
    throw new Error("pr_context clone_url must match the bound GitHub repository");
  }
  if (!headRef || headRef.length > 255 || headRef.startsWith("-") || headRef.includes("..") || headRef.includes("\\")) {
    throw new Error("pr_context head_ref is invalid");
  }
  if (!baseRef || baseRef.length > 255 || baseRef.startsWith("-") || baseRef.includes("..") || baseRef.includes("\\")) {
    throw new Error("pr_context base_ref is invalid");
  }
  if (!SHA.test(initialHeadSha) || !SHA.test(baseSha)) throw new Error("pr_context commit SHA is invalid");
  if (!/^[0-9a-f]{64}$/.test(taskDocumentSha256)) throw new Error("pr_context task_document_sha256 is invalid");
  const taskDocument = listDagRunInputs(runId).find((entry) => entry.logical_name === "task_document");
  if (!taskDocument || taskDocument.sha256 !== taskDocumentSha256) {
    throw new Error("pr_context task_document_sha256 does not match the immutable task_document input");
  }
  if (!Array.isArray(raw.writable_paths) || raw.writable_paths.length < 1 || raw.writable_paths.length > 128) {
    throw new Error("pr_context writable_paths must be a non-empty bounded allowlist");
  }
  const writablePaths = raw.writable_paths.map((entry, index) => (
    safeRelativePath(entry, `pr_context writable_paths[${index}]`)
  ));
  if (!Array.isArray(raw.required_checks) || raw.required_checks.length < 1 || raw.required_checks.length > 32) {
    throw new Error("pr_context required_checks must be a non-empty bounded list");
  }
  const requiredChecks = raw.required_checks.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`pr_context required_checks[${index}] is invalid`);
    const name = entry.trim();
    if (!name || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new Error(`pr_context required_checks[${index}] is invalid`);
    }
    return name;
  });
  if (new Set(requiredChecks).size !== requiredChecks.length) {
    throw new Error("pr_context required_checks must be unique");
  }
  let validationWorkflow: GithubPullRequestContext["validation_workflow"];
  if (raw.validation_workflow !== undefined) {
    const configured = jsonRecord(raw.validation_workflow, "pr_context validation_workflow");
    const workflowId = String(configured.workflow_id ?? "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workflowId)) {
      throw new Error("pr_context validation_workflow workflow_id is invalid");
    }
    const configuredInputs = jsonRecord(configured.inputs ?? {}, "pr_context validation_workflow inputs");
    if (Object.keys(configuredInputs).length > 32) {
      throw new Error("pr_context validation_workflow inputs exceed the bounded limit");
    }
    const inputs: Record<string, string> = {};
    for (const [key, value] of Object.entries(configuredInputs).sort(([left], [right]) => left.localeCompare(right))) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(key) || typeof value !== "string" || value.length > 1_024) {
        throw new Error("pr_context validation_workflow input is invalid");
      }
      inputs[key] = value;
    }
    validationWorkflow = { workflow_id: workflowId, inputs };
  }
  return {
    version: 1,
    owner,
    repo,
    pull_number: pullNumber,
    clone_url: cloneUrl,
    head_ref: headRef,
    base_ref: baseRef,
    initial_head_sha: initialHeadSha,
    base_sha: baseSha,
    task_document_sha256: taskDocumentSha256,
    require_draft: raw.require_draft !== false,
    writable_paths: Array.from(new Set(writablePaths)).sort(),
    required_checks: [...requiredChecks].sort(),
    ...(validationWorkflow ? { validation_workflow: validationWorkflow } : {}),
  };
}

async function githubToken(context: CredentialBrokerContext): Promise<string> {
  const direct = context.secret.token ?? context.secret.access_token ?? context.secret.value;
  if (direct) return direct;
  const appId = context.secret.app_id;
  const installationId = context.secret.installation_id;
  const privateKey = context.secret.private_key;
  if (!appId || !installationId || !privateKey) {
    throw new Error("github_pr requires a token or GitHub App installation credential");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const unsigned = `${header}.${payload}`;
  const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
  const response = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "user-agent": "HomeRail-Autofix-Broker",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub App installation authentication failed (${response.status})`);
  const body = jsonRecord(await response.json(), "GitHub App token response");
  if (typeof body.token !== "string" || !body.token) throw new Error("GitHub App installation token is missing");
  return body.token;
}

async function githubApi<T>(token: string, pathname: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.github.com${pathname}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "HomeRail-Autofix-Broker",
      "x-github-api-version": "2022-11-28",
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub API request failed (${response.status})`);
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

interface NormalizedCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  details_url: string;
  output: {
    title: string;
    summary: string;
    text: string;
  };
}

function normalizeCheckRun(check: Record<string, unknown>): NormalizedCheckRun {
  const output = check.output && typeof check.output === "object" && !Array.isArray(check.output)
    ? check.output as Record<string, unknown>
    : {};
  const numericId = Number(check.id ?? 0);
  return {
    id: Number.isSafeInteger(numericId) && numericId >= 0 ? numericId : 0,
    name: String(check.name ?? "").slice(0, 256),
    status: String(check.status ?? "").slice(0, 64),
    conclusion: check.conclusion === null ? null : String(check.conclusion ?? "").slice(0, 64),
    details_url: String(check.details_url ?? "").slice(0, 2_000),
    output: {
      title: String(output.title ?? "").slice(0, 1_000),
      summary: String(output.summary ?? "").slice(0, 8_000),
      text: String(output.text ?? "").slice(0, 8_000),
    },
  };
}

async function githubCheckRuns(token: string, binding: GithubPullRequestContext, headSha: string): Promise<NormalizedCheckRun[]> {
  const first = await githubApi<{ check_runs?: Array<Record<string, unknown>> }>(
    token,
    `${repoPath(binding)}/commits/${headSha}/check-runs?per_page=100&page=1`,
  );
  const checks = [...(first.check_runs ?? [])];
  if (checks.length === 100) {
    const second = await githubApi<{ check_runs?: Array<Record<string, unknown>> }>(
      token,
      `${repoPath(binding)}/commits/${headSha}/check-runs?per_page=100&page=2`,
    );
    checks.push(...(second.check_runs ?? []));
    if ((second.check_runs ?? []).length === 100) {
      const overflow = await githubApi<{ check_runs?: Array<Record<string, unknown>> }>(
        token,
        `${repoPath(binding)}/commits/${headSha}/check-runs?per_page=100&page=3`,
      );
      if ((overflow.check_runs ?? []).length > 0) {
        throw new Error("GitHub check run list exceeds the bounded snapshot");
      }
    }
  }
  return checks.map(normalizeCheckRun);
}

function latestRequiredChecks(
  checks: NormalizedCheckRun[],
  requiredNames: string[],
  minimumIds?: ReadonlyMap<string, number>,
): NormalizedCheckRun[] {
  return requiredNames.map((name) => checks
    .filter((check) => check.name === name && check.id > (minimumIds?.get(name) ?? -1))
    .sort((left, right) => right.id - left.id)[0] ?? {
      id: 0,
      name,
      status: "missing",
      conclusion: null,
      details_url: "",
      output: { title: "", summary: "", text: "" },
    });
}

function checksPassed(checks: NormalizedCheckRun[]): boolean {
  return checks.every((check) => check.status === "completed" && check.conclusion === "success");
}

function checksTerminal(checks: NormalizedCheckRun[]): boolean {
  return checks.every((check) => check.status === "completed" && check.conclusion !== null);
}

function validationMetadata(input: Readonly<Record<string, unknown>>, headSha: string): {
  head_sha: string;
  manifest_sha256: string;
  summary: string;
  tests: string[];
} {
  const manifest = String(input.manifest_sha256 ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(manifest)) throw new Error("validate_head manifest_sha256 is invalid");
  if (typeof input.summary !== "string" || input.summary.length > 12_000) {
    throw new Error("validate_head summary is invalid");
  }
  const summary = input.summary.trim();
  if (!Array.isArray(input.tests) || input.tests.length > 50 || input.tests.some((entry) => (
    typeof entry !== "string" || entry.length > 2_000
  ))) {
    throw new Error("validate_head tests are invalid");
  }
  const tests = [...input.tests] as string[];
  return { head_sha: headSha, manifest_sha256: manifest, summary, tests };
}

function repoPath(context: GithubPullRequestContext): string {
  return `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repo)}`;
}

function stateIdentity(context: GithubPullRequestContext): string {
  return `${context.owner}/${context.repo}#${context.pull_number}:${context.head_ref}`;
}

function pullHead(pull: PullResponse, context: GithubPullRequestContext): string {
  const head = String(pull.head?.sha ?? "").toLowerCase();
  if (!SHA.test(head)) throw new Error("GitHub pull request has no valid head SHA");
  const repository = `${context.owner}/${context.repo}`;
  if (
    pull.number !== context.pull_number
    || pull.state !== "open"
    || pull.head?.ref !== context.head_ref
    || pull.base?.ref !== context.base_ref
    || pull.head?.repo?.full_name !== repository
    || pull.base?.repo?.full_name !== repository
    || pull.base?.sha?.toLowerCase() !== context.base_sha
  ) {
    throw new Error("GitHub pull request identity differs from immutable pr_context");
  }
  if (context.require_draft && pull.draft !== true) throw new Error("Autofix requires the bound pull request to remain Draft");
  return head;
}

function reconcileState(runId: string, context: GithubPullRequestContext, remoteHead: string): GithubPullRequestState {
  const identity = stateIdentity(context);
  const raw = getActiveRunBrokerState(runId, "github_pr");
  if (raw === undefined) {
    if (remoteHead !== context.initial_head_sha) throw new Error("Draft PR head changed before the broker was bound");
    const initialized: GithubPullRequestState = {
      version: 1,
      identity,
      current_head_sha: remoteHead,
    };
    setActiveRunBrokerState(runId, "github_pr", initialized);
    return initialized;
  }
  const record = jsonRecord(raw, "github_pr broker state");
  const state: GithubPullRequestState = {
    version: 1,
    identity: String(record.identity ?? ""),
    current_head_sha: String(record.current_head_sha ?? "").toLowerCase(),
    ...(typeof record.pending_head_sha === "string" ? { pending_head_sha: record.pending_head_sha.toLowerCase() } : {}),
  };
  if (record.version !== 1 || state.identity !== identity || !SHA.test(state.current_head_sha)) {
    throw new Error("Persisted GitHub broker state is invalid");
  }
  if (state.pending_head_sha) {
    if (!SHA.test(state.pending_head_sha)) throw new Error("Persisted GitHub pending head is invalid");
    if (remoteHead === state.pending_head_sha) {
      const finalized = { version: 1 as const, identity, current_head_sha: remoteHead };
      setActiveRunBrokerState(runId, "github_pr", finalized);
      return finalized;
    }
    if (remoteHead === state.current_head_sha) {
      const cleared = { version: 1 as const, identity, current_head_sha: remoteHead };
      setActiveRunBrokerState(runId, "github_pr", cleared);
      return cleared;
    }
    throw new Error("Draft PR head changed while a broker mutation was pending");
  }
  if (remoteHead !== state.current_head_sha) throw new Error("Draft PR head changed outside the HomeRail broker");
  return state;
}

async function boundPull(context: CredentialBrokerContext): Promise<{
  token: string;
  binding: GithubPullRequestContext;
  pull: PullResponse;
  state: GithubPullRequestState;
}> {
  const runId = context.transport?.run_id;
  if (!runId) throw new Error("github_pr broker requires a run transport identity");
  const binding = parsePullRequestContext(runId);
  const token = await githubToken(context);
  const pull = await githubApi<PullResponse>(token, `${repoPath(binding)}/pulls/${binding.pull_number}`);
  const state = reconcileState(runId, binding, pullHead(pull, binding));
  return { token, binding, pull, state };
}

export async function githubPullRequestSnapshot(context: CredentialBrokerContext): Promise<unknown> {
  const { token, binding, pull, state } = await boundPull(context);
  const files = await githubApi<Array<Record<string, unknown>>>(
    token,
    `${repoPath(binding)}/pulls/${binding.pull_number}/files?per_page=100&page=1`,
  );
  if (files.length === 100) {
    const overflow = await githubApi<Array<Record<string, unknown>>>(
      token,
      `${repoPath(binding)}/pulls/${binding.pull_number}/files?per_page=100&page=2`,
    );
    if (overflow.length > 0) throw new Error("GitHub pull request file list exceeds the bounded snapshot");
  }
  return {
    repository: `${binding.owner}/${binding.repo}`,
    pull_number: binding.pull_number,
    title: String(pull.title ?? ""),
    body: String(pull.body ?? "").slice(0, 32_000),
    draft: pull.draft === true,
    state: String(pull.state ?? ""),
    url: String(pull.html_url ?? ""),
    head_ref: binding.head_ref,
    head_sha: state.current_head_sha,
    base_sha: binding.base_sha,
    files: files.slice(0, 100).map((file) => ({
      filename: String(file.filename ?? ""),
      sha: String(file.sha ?? "").toLowerCase(),
      status: String(file.status ?? ""),
      additions: Number(file.additions ?? 0),
      deletions: Number(file.deletions ?? 0),
      changes: Number(file.changes ?? 0),
      patch: typeof file.patch === "string" ? file.patch.slice(0, MAX_PATCH_CHARS) : undefined,
    })),
  };
}

export async function githubReadFile(context: CredentialBrokerContext): Promise<unknown> {
  const { token, binding, state } = await boundPull(context);
  const expectedHead = String(context.input.expected_head_sha ?? "").toLowerCase();
  if (!SHA.test(expectedHead)) throw new Error("read_file expected_head_sha is invalid");
  if (expectedHead !== state.current_head_sha) throw new Error("read_file expected head is stale");
  const pathname = safeRelativePath(context.input.path, "read_file path");
  const encodedPath = pathname.split("/").map(encodeURIComponent).join("/");
  const file = await githubApi<Record<string, unknown>>(
    token,
    `${repoPath(binding)}/contents/${encodedPath}?ref=${encodeURIComponent(expectedHead)}`,
  );
  if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string") {
    throw new Error("read_file path is not a regular GitHub file");
  }
  const encoded = file.content.replace(/\s+/g, "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Error("read_file GitHub content is not canonical base64");
  if (bytes.byteLength > MAX_READ_FILE_BYTES) {
    throw new Error(`read_file exceeds ${MAX_READ_FILE_BYTES} bytes`);
  }
  const text = bytes.toString("utf8");
  if (Buffer.from(text, "utf8").compare(bytes) !== 0 || text.includes("\0")) {
    throw new Error("read_file supports UTF-8 text files only");
  }
  const blobSha = String(file.sha ?? "").toLowerCase();
  if (!SHA.test(blobSha)) throw new Error("read_file GitHub blob SHA is invalid");
  if (Buffer.byteLength(JSON.stringify(text), "utf8") > MAX_READ_FILE_JSON_BYTES) {
    throw new Error("read_file escaped text exceeds the bounded broker result");
  }
  return {
    head_sha: state.current_head_sha,
    path: pathname,
    blob_sha: blobSha,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    content: text,
  };
}

export async function githubChecksSnapshot(context: CredentialBrokerContext): Promise<unknown> {
  const { token, binding, state } = await boundPull(context);
  const checks = await githubCheckRuns(token, binding, state.current_head_sha);
  return {
    head_sha: state.current_head_sha,
    checks,
  };
}

export async function githubRequiredChecks(context: CredentialBrokerContext): Promise<unknown> {
  const { token, binding, state } = await boundPull(context);
  const expectedHead = context.input.expected_head_sha === undefined
    ? state.current_head_sha
    : String(context.input.expected_head_sha).toLowerCase();
  if (!SHA.test(expectedHead) || expectedHead !== state.current_head_sha) {
    throw new Error("required_checks expected head is stale or invalid");
  }
  const required = latestRequiredChecks(
    await githubCheckRuns(token, binding, expectedHead),
    binding.required_checks,
  );
  const failed = required.filter((check) => check.status !== "completed" || check.conclusion !== "success");
  if (failed.length > 0) {
    throw new Error(`Required GitHub checks are not successful: ${failed.map((check) => check.name).join(", ")}`);
  }
  return {
    passed: true,
    head_sha: state.current_head_sha,
    required_checks: required,
  };
}

function validationFeedback(checks: NormalizedCheckRun[]): string[] {
  return checks
    .filter((check) => check.status !== "completed" || check.conclusion !== "success")
    .map((check) => {
      const evidence = [check.output.title, check.output.summary, check.output.text, check.details_url]
        .map((entry) => entry.trim())
        .filter(Boolean)
        .join(" | ")
        .slice(0, 4_000);
      return `Required check ${check.name} finished as ${check.status}/${check.conclusion ?? "none"}${evidence ? `: ${evidence}` : ""}`;
    });
}

async function assertValidationHeadStillCurrent(
  token: string,
  binding: GithubPullRequestContext,
  expectedHead: string,
): Promise<void> {
  const pull = await githubApi<PullResponse>(token, `${repoPath(binding)}/pulls/${binding.pull_number}`);
  if (pullHead(pull, binding) !== expectedHead) {
    throw new Error("validate_head expected head changed while validation was running");
  }
}

function assertValidationRunActive(context: CredentialBrokerContext): void {
  const runId = context.transport?.run_id;
  if (!runId || getActiveRun(runId)?.status !== "active") {
    throw new Error("validate_head run is no longer active");
  }
}

export async function githubValidateHead(context: CredentialBrokerContext): Promise<unknown> {
  assertValidationRunActive(context);
  const { token, binding, state } = await boundPull(context);
  const expectedHead = String(context.input.expected_head_sha ?? "").toLowerCase();
  if (!SHA.test(expectedHead) || expectedHead !== state.current_head_sha) {
    throw new Error("validate_head expected head is stale or invalid");
  }
  const metadata = validationMetadata(context.input, expectedHead);
  const initialChecks = await githubCheckRuns(token, binding, expectedHead);
  const initialRequired = latestRequiredChecks(initialChecks, binding.required_checks);
  if (checksPassed(initialRequired)) {
    await assertValidationHeadStillCurrent(token, binding, expectedHead);
    return {
      status: "passed",
      verdict: "validated",
      ...metadata,
      validation: { workflow_dispatched: false, required_checks: initialRequired },
      feedback: [],
      fix_tasks: [],
    };
  }

  let workflowDispatched = false;
  let minimumIds: Map<string, number> | undefined;
  if (binding.validation_workflow) {
    minimumIds = new Map(binding.required_checks.map((name) => [
      name,
      initialChecks
        .filter((check) => check.name === name)
        .reduce((latest, check) => Math.max(latest, check.id), 0),
    ]));
    const inputs = Object.fromEntries(Object.entries(binding.validation_workflow.inputs).map(([key, value]) => [
      key,
      value === "$head_sha" ? expectedHead : value,
    ]));
    await githubApi<void>(
      token,
      `${repoPath(binding)}/actions/workflows/${encodeURIComponent(binding.validation_workflow.workflow_id)}/dispatches`,
      {
        method: "POST",
        body: JSON.stringify({ ref: binding.head_ref, inputs }),
      },
    );
    workflowDispatched = true;
  }

  const deadline = Date.now() + VALIDATION_TIMEOUT_MS;
  while (true) {
    assertValidationRunActive(context);
    const required = latestRequiredChecks(
      await githubCheckRuns(token, binding, expectedHead),
      binding.required_checks,
      minimumIds,
    );
    if (checksPassed(required)) {
      await assertValidationHeadStillCurrent(token, binding, expectedHead);
      return {
        status: "passed",
        verdict: "validated",
        ...metadata,
        validation: { workflow_dispatched: workflowDispatched, required_checks: required },
        feedback: [],
        fix_tasks: [],
      };
    }
    if (checksTerminal(required)) {
      await assertValidationHeadStillCurrent(token, binding, expectedHead);
      const feedback = validationFeedback(required);
      return {
        status: "failed",
        verdict: "changes_requested",
        ...metadata,
        validation: { workflow_dispatched: workflowDispatched, required_checks: required },
        feedback,
        fix_tasks: [{ id: "trusted-validation", feedback }],
      };
    }
    if (Date.now() >= deadline) {
      await assertValidationHeadStillCurrent(token, binding, expectedHead);
      return {
        status: "timed_out",
        verdict: "blocked",
        ...metadata,
        validation: { workflow_dispatched: workflowDispatched, required_checks: required },
        feedback: ["Timed out waiting for required checks on the exact Draft PR head"],
        fix_tasks: [],
      };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, VALIDATION_POLL_INTERVAL_MS));
  }
}

function pathAllowed(pathname: string, prefixes: string[]): boolean {
  if (
    pathname === ".git" || pathname.startsWith(".git/")
    || pathname === ".github" || pathname.startsWith(".github/")
    || pathname === "input" || pathname.startsWith("input/")
  ) return false;
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function commitFilesInput(input: Readonly<Record<string, unknown>>, binding: GithubPullRequestContext): {
  expectedHead: string;
  message: string;
  files: Array<{ path: string; mode: "100644" | "100755"; bytes: Buffer }>;
} {
  const expectedHead = String(input.expected_head_sha ?? "").toLowerCase();
  const message = String(input.message ?? "").trim();
  if (!SHA.test(expectedHead)) throw new Error("commit_files expected_head_sha is invalid");
  if (!message || message.length > 512 || /[\r\n]/.test(message)) throw new Error("commit_files message is invalid");
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > MAX_COMMIT_FILES) {
    throw new Error(`commit_files requires 1-${MAX_COMMIT_FILES} files`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const files = input.files.map((entry, index) => {
    const raw = jsonRecord(entry, `commit_files files[${index}]`);
    const pathname = safeRelativePath(raw.path, `commit_files files[${index}].path`);
    if (seen.has(pathname)) throw new Error(`commit_files path is duplicated: ${pathname}`);
    if (!pathAllowed(pathname, binding.writable_paths)) throw new Error(`commit_files path is outside the PR write allowlist: ${pathname}`);
    seen.add(pathname);
    const encoded = String(raw.content_base64 ?? "");
    if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error(`commit_files content_base64 is invalid for ${pathname}`);
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new Error(`commit_files content_base64 is not canonical for ${pathname}`);
    totalBytes += bytes.byteLength;
    const mode: "100644" | "100755" = raw.mode === "100755" ? "100755" : "100644";
    return { path: pathname, mode, bytes };
  });
  if (totalBytes > MAX_COMMIT_BYTES) throw new Error("commit_files content exceeds 1 MiB");
  return { expectedHead, message, files };
}

interface GithubCommitFile {
  path: string;
  mode: "100644" | "100755";
  bytes: Buffer | null;
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function git(workspace: string, args: string[], maxBuffer = 2 * 1024 * 1024): string {
  const result = spawnSync("git", ["-C", workspace, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer,
    shell: false,
  });
  if (result.status !== 0 || result.error) {
    const detail = String(result.stderr || result.error?.message || "unknown error").trim().slice(0, 1_000);
    throw new Error(`commit_workspace Git inspection failed: ${detail}`);
  }
  return String(result.stdout);
}

function assertNoSymlinkFilePath(root: string, pathname: string): fs.Stats | undefined {
  let current = root;
  const segments = pathname.split("/");
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]!);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`commit_workspace rejects symlink paths: ${pathname}`);
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`commit_workspace path parent is not a directory: ${pathname}`);
    }
    if (index === segments.length - 1) return stat;
  }
  return undefined;
}

function assertTrackedModeIsRegular(workspace: string, pathname: string): void {
  const staged = git(workspace, ["ls-files", "--stage", "-z", "--", pathname]).split("\0").filter(Boolean);
  if (staged.length === 0) return;
  if (staged.length !== 1) throw new Error(`commit_workspace path has ambiguous Git stages: ${pathname}`);
  const mode = staged[0]!.slice(0, 6);
  if (mode !== "100644" && mode !== "100755") {
    throw new Error(`commit_workspace rejects non-regular tracked path mode ${mode}: ${pathname}`);
  }
}

function writableWorkspace(context: CredentialBrokerContext): { relative: string; absolute: string } {
  const runId = context.transport?.run_id;
  const nodeId = context.transport?.node_id;
  if (!runId || !nodeId) throw new Error("commit_workspace requires a run and node transport identity");
  const run = getActiveRun(runId);
  const node = run?.dagRun.graph.nodes.find((candidate) => candidate.node_id === nodeId);
  const runtime = node?.extra?.agent_runtime;
  const access = runtime && typeof runtime === "object" && !Array.isArray(runtime)
    ? (runtime as Record<string, unknown>).workspace_access
    : undefined;
  const writable = access && typeof access === "object" && !Array.isArray(access)
    ? (access as Record<string, unknown>).writable_paths
    : undefined;
  if (!Array.isArray(writable) || writable.length !== 1 || typeof writable[0] !== "string") {
    throw new Error("commit_workspace requires exactly one declared writable workspace");
  }
  const relative = safeRelativePath(writable[0], "commit_workspace declared writable path");
  if (context.input.workspace_path !== relative) {
    throw new Error("commit_workspace workspace_path does not match the node write boundary");
  }
  const runRoot = fs.realpathSync(runWorkspacePath(runId));
  const candidate = path.resolve(runRoot, ...relative.split("/"));
  const absolute = fs.realpathSync(candidate);
  if (!isPathInside(runRoot, absolute)) throw new Error("commit_workspace path escapes the run workspace");
  const topLevel = fs.realpathSync(git(absolute, ["rev-parse", "--show-toplevel"]).trim());
  if (topLevel !== absolute) throw new Error("commit_workspace path is not the declared Git worktree root");
  const gitDir = fs.realpathSync(git(absolute, ["rev-parse", "--path-format=absolute", "--git-dir"]).trim());
  const commonDir = fs.realpathSync(git(absolute, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
  if (!isPathInside(runRoot, gitDir) || !isPathInside(runRoot, commonDir)) {
    throw new Error("commit_workspace Git metadata escapes the run workspace");
  }
  return { relative, absolute };
}

function workspaceCommitInput(
  context: CredentialBrokerContext,
  binding: GithubPullRequestContext,
): { expectedHead: string; message: string; workspacePath: string; files: GithubCommitFile[]; manifestSha256: string } {
  const expectedHead = String(context.input.expected_head_sha ?? "").toLowerCase();
  const message = String(context.input.message ?? "").trim();
  if (!SHA.test(expectedHead)) throw new Error("commit_workspace expected_head_sha is invalid");
  if (!message || message.length > 512 || /[\r\n]/.test(message)) {
    throw new Error("commit_workspace message is invalid");
  }
  const workspace = writableWorkspace(context);
  const localHead = git(workspace.absolute, ["rev-parse", "HEAD"]).trim().toLowerCase();
  if (localHead !== expectedHead) throw new Error("commit_workspace worktree HEAD differs from expected_head_sha");
  const changed = git(workspace.absolute, ["diff", "--no-ext-diff", "--name-only", "-z", "--no-renames", "HEAD", "--"])
    .split("\0").filter(Boolean);
  const untracked = git(workspace.absolute, ["ls-files", "--others", "--exclude-standard", "-z", "--"])
    .split("\0").filter(Boolean);
  const paths = Array.from(new Set([...changed, ...untracked])).sort();
  if (paths.length < 1 || paths.length > MAX_COMMIT_FILES) {
    throw new Error(`commit_workspace requires 1-${MAX_COMMIT_FILES} changed files`);
  }
  let totalBytes = 0;
  const files = paths.map((rawPath) => {
    const pathname = safeRelativePath(rawPath, "commit_workspace changed path");
    if (!pathAllowed(pathname, binding.writable_paths)) {
      throw new Error(`commit_workspace path is outside the PR write allowlist: ${pathname}`);
    }
    assertTrackedModeIsRegular(workspace.absolute, pathname);
    const stat = assertNoSymlinkFilePath(workspace.absolute, pathname);
    if (!stat) return { path: pathname, mode: "100644" as const, bytes: null };
    if (!stat.isFile()) throw new Error(`commit_workspace path is not a regular file: ${pathname}`);
    const bytes = fs.readFileSync(path.join(workspace.absolute, ...pathname.split("/")));
    totalBytes += bytes.byteLength;
    return {
      path: pathname,
      mode: (stat.mode & 0o111) !== 0 ? "100755" as const : "100644" as const,
      bytes,
    };
  });
  if (totalBytes > MAX_COMMIT_BYTES) throw new Error("commit_workspace content exceeds 1 MiB");
  const manifest = files.map((file) => ({
    path: file.path,
    mode: file.bytes === null ? null : file.mode,
    sha256: file.bytes === null ? null : createHash("sha256").update(file.bytes).digest("hex"),
  }));
  return {
    expectedHead,
    message,
    workspacePath: workspace.relative,
    files,
    manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
  };
}

async function commitFiles(
  runId: string,
  token: string,
  binding: GithubPullRequestContext,
  state: GithubPullRequestState,
  request: { expectedHead: string; message: string; files: GithubCommitFile[] },
): Promise<{ previousHead: string; nextHead: string }> {
  if (request.expectedHead !== state.current_head_sha) throw new Error("commit_files expected head is stale");
  const repository = repoPath(binding);
  const commit = await githubApi<{ tree?: { sha?: string } }>(token, `${repository}/git/commits/${state.current_head_sha}`);
  const baseTree = String(commit.tree?.sha ?? "").toLowerCase();
  if (!SHA.test(baseTree)) throw new Error("GitHub base tree SHA is invalid");
  const treeEntries = [];
  for (const file of request.files) {
    if (file.bytes === null) {
      treeEntries.push({ path: file.path, mode: file.mode, type: "blob", sha: null });
      continue;
    }
    const blob = await githubApi<{ sha?: string }>(token, `${repository}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: file.bytes.toString("base64"), encoding: "base64" }),
    });
    const blobSha = String(blob.sha ?? "").toLowerCase();
    if (!SHA.test(blobSha)) throw new Error("GitHub blob SHA is invalid");
    treeEntries.push({ path: file.path, mode: file.mode, type: "blob", sha: blobSha });
  }
  const tree = await githubApi<{ sha?: string }>(token, `${repository}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTree, tree: treeEntries }),
  });
  const treeSha = String(tree.sha ?? "").toLowerCase();
  if (!SHA.test(treeSha)) throw new Error("GitHub tree SHA is invalid");
  if (treeSha === baseTree) throw new Error("GitHub broker commit would not change the repository tree");
  const nextCommit = await githubApi<{ sha?: string }>(token, `${repository}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: request.message, tree: treeSha, parents: [state.current_head_sha] }),
  });
  const nextHead = String(nextCommit.sha ?? "").toLowerCase();
  if (!SHA.test(nextHead)) throw new Error("GitHub commit SHA is invalid");
  setActiveRunBrokerState(runId, "github_pr", { ...state, pending_head_sha: nextHead } satisfies GithubPullRequestState);
  const refPath = binding.head_ref.split("/").map(encodeURIComponent).join("/");
  try {
    await githubApi(token, `${repository}/git/refs/heads/${refPath}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: nextHead, force: false }),
    });
  } catch (error) {
    const pull = await githubApi<PullResponse>(token, `${repository}/pulls/${binding.pull_number}`);
    const observedHead = pullHead(pull, binding);
    if (observedHead !== nextHead) {
      if (observedHead === state.current_head_sha) setActiveRunBrokerState(runId, "github_pr", state);
      throw error;
    }
  }
  setActiveRunBrokerState(runId, "github_pr", {
    version: 1,
    identity: state.identity,
    current_head_sha: nextHead,
  } satisfies GithubPullRequestState);
  return { previousHead: state.current_head_sha, nextHead };
}

export async function githubCommitFiles(context: CredentialBrokerContext): Promise<unknown> {
  const runId = context.transport?.run_id;
  if (!runId) throw new Error("github_pr broker requires a run transport identity");
  const { token, binding, state } = await boundPull(context);
  const request = commitFilesInput(context.input, binding);
  const committed = await commitFiles(runId, token, binding, state, request);
  return {
    repository: `${binding.owner}/${binding.repo}`,
    pull_number: binding.pull_number,
    previous_head_sha: committed.previousHead,
    head_sha: committed.nextHead,
    committed_files: request.files.map((file) => file.path),
  };
}

export async function githubCommitWorkspace(context: CredentialBrokerContext): Promise<unknown> {
  const runId = context.transport?.run_id;
  if (!runId) throw new Error("github_pr broker requires a run transport identity");
  const { token, binding, state } = await boundPull(context);
  const request = workspaceCommitInput(context, binding);
  const committed = await commitFiles(runId, token, binding, state, request);
  return {
    repository: `${binding.owner}/${binding.repo}`,
    pull_number: binding.pull_number,
    previous_head_sha: committed.previousHead,
    head_sha: committed.nextHead,
    workspace_path: request.workspacePath,
    manifest_sha256: request.manifestSha256,
    committed_files: request.files.map((file) => file.path),
  };
}

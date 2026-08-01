import { sign } from "node:crypto";
import * as fs from "node:fs";

import {
  dagRunInputPath,
  listDagRunInputs,
} from "../persistence/run-input-artifacts.js";
import {
  getActiveRunBrokerState,
  setActiveRunBrokerState,
} from "./active-runs.js";
import type { CredentialBrokerContext } from "./credential-broker.js";

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
const MAX_PATCH_CHARS = 8_000;

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
  return await response.json() as T;
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
    `${repoPath(binding)}/pulls/${binding.pull_number}/files?per_page=100`,
  );
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
      status: String(file.status ?? ""),
      additions: Number(file.additions ?? 0),
      deletions: Number(file.deletions ?? 0),
      changes: Number(file.changes ?? 0),
      patch: typeof file.patch === "string" ? file.patch.slice(0, MAX_PATCH_CHARS) : undefined,
    })),
  };
}

export async function githubChecksSnapshot(context: CredentialBrokerContext): Promise<unknown> {
  const { token, binding, state } = await boundPull(context);
  const body = await githubApi<{ check_runs?: Array<Record<string, unknown>> }>(
    token,
    `${repoPath(binding)}/commits/${state.current_head_sha}/check-runs?per_page=100`,
  );
  return {
    head_sha: state.current_head_sha,
    checks: (body.check_runs ?? []).slice(0, 100).map((check) => ({
      id: Number(check.id ?? 0),
      name: String(check.name ?? ""),
      status: String(check.status ?? ""),
      conclusion: check.conclusion === null ? null : String(check.conclusion ?? ""),
      details_url: String(check.details_url ?? ""),
      started_at: String(check.started_at ?? ""),
      completed_at: check.completed_at === null ? null : String(check.completed_at ?? ""),
    })),
  };
}

export async function githubRequiredChecks(context: CredentialBrokerContext): Promise<unknown> {
  const { token, binding, state } = await boundPull(context);
  const body = await githubApi<{ check_runs?: Array<Record<string, unknown>> }>(
    token,
    `${repoPath(binding)}/commits/${state.current_head_sha}/check-runs?per_page=100`,
  );
  const checks = body.check_runs ?? [];
  const required = binding.required_checks.map((name) => {
    const latest = checks
      .filter((check) => String(check.name ?? "") === name)
      .sort((left, right) => Number(right.id ?? 0) - Number(left.id ?? 0))[0];
    return {
      name,
      id: Number(latest?.id ?? 0),
      status: String(latest?.status ?? "missing"),
      conclusion: latest?.conclusion === null || latest === undefined
        ? null
        : String(latest.conclusion ?? ""),
    };
  });
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

export async function githubCommitFiles(context: CredentialBrokerContext): Promise<unknown> {
  const runId = context.transport?.run_id;
  if (!runId) throw new Error("github_pr broker requires a run transport identity");
  const { token, binding, state } = await boundPull(context);
  const request = commitFilesInput(context.input, binding);
  if (request.expectedHead !== state.current_head_sha) throw new Error("commit_files expected head is stale");
  const repository = repoPath(binding);
  const commit = await githubApi<{ tree?: { sha?: string } }>(token, `${repository}/git/commits/${state.current_head_sha}`);
  const baseTree = String(commit.tree?.sha ?? "").toLowerCase();
  if (!SHA.test(baseTree)) throw new Error("GitHub base tree SHA is invalid");
  const treeEntries = [];
  for (const file of request.files) {
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
  const nextCommit = await githubApi<{ sha?: string }>(token, `${repository}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: request.message,
      tree: treeSha,
      parents: [state.current_head_sha],
    }),
  });
  const nextHead = String(nextCommit.sha ?? "").toLowerCase();
  if (!SHA.test(nextHead)) throw new Error("GitHub commit SHA is invalid");
  setActiveRunBrokerState(runId, "github_pr", {
    ...state,
    pending_head_sha: nextHead,
  } satisfies GithubPullRequestState);
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
  const finalized: GithubPullRequestState = {
    version: 1,
    identity: state.identity,
    current_head_sha: nextHead,
  };
  setActiveRunBrokerState(runId, "github_pr", finalized);
  return {
    repository: `${binding.owner}/${binding.repo}`,
    pull_number: binding.pull_number,
    previous_head_sha: state.current_head_sha,
    head_sha: nextHead,
    committed_files: request.files.map((file) => file.path),
  };
}

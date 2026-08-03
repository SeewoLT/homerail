/**
 * Durable run-scoped review evidence.
 *
 * Accepted findings, compact coverage attestations, and provider-neutral
 * attempt diagnostics are stored append-only in the Manager DB, fenced to the
 * exact run/reviewer/session/generation/attempt. Re-delivery is idempotent:
 * findings deduplicate by deterministic finding id, diagnostics deduplicate
 * per attempt, and coverage deduplicates per round. A bounded redacted
 * projection is mirrored into the run workspace for deterministic command
 * normalizers.
 * @version 0.1.0
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getHomerailHome } from "../config/env.js";
import { getDb, parseJsonRow } from "./db.js";
import { nowEpochMs } from "./time.js";
import {
  ATTEMPT_DIAGNOSTIC_SCHEMA_ID,
  REVIEW_EVIDENCE_PROJECTION_SCHEMA_ID,
  buildReviewEvidenceProjection,
  extractReviewEvidence,
  normalizeReviewFinding,
  sanitizeAttemptDiagnostic,
  validateChangedFileCoverageAttestationShape,
  type AttemptDiagnosticV1,
  type ChangedFileCoverageAttestationV1,
  type ReviewEvidenceProjectionV1,
  type ReviewEvidenceSubmissionV1,
  type ReviewFindingV1,
} from "homerail-protocol";

export type ReviewEvidenceKind = "finding" | "diagnostic" | "coverage";

export interface ReviewEvidenceIdentity {
  runId: string;
  reviewer: string;
  nodeId: string;
  sessionId: string;
  roundId: string;
  generation: number;
  attempt: number;
}

export interface ReviewEvidenceRecord {
  schemaVersion: 1;
  identity: ReviewEvidenceIdentity;
  kind: ReviewEvidenceKind;
  dedupKey: string;
  payload: ReviewFindingV1 | AttemptDiagnosticV1 | ChangedFileCoverageAttestationV1;
  createdAt: number;
}

export interface ReviewEvidenceWriteResult {
  status: "inserted" | "deduplicated";
  record?: ReviewEvidenceRecord;
}

export interface ReviewHandoffEvidenceInput {
  /** Provider-neutral transport diagnostic (from the Worker terminal payload). */
  transportDiagnostic?: unknown;
  /** Bounded evidence extracted from handoff content. */
  submission?: ReviewEvidenceSubmissionV1;
  /** Optional reason used to classify a failed attempt. */
  failureReason?: string;
}

export interface LoadedReviewEvidence {
  findings: ReviewFindingV1[];
  diagnostics: AttemptDiagnosticV1[];
  coverageAttestation?: ChangedFileCoverageAttestationV1 | null;
}

function boundedIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 256) {
    throw new Error(`${label} must be a non-empty string of at most 256 characters`);
  }
  return value.trim();
}

function boundedInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function validateIdentity(identity: ReviewEvidenceIdentity): ReviewEvidenceIdentity {
  return {
    runId: boundedIdentity(identity.runId, "evidence run_id"),
    reviewer: boundedIdentity(identity.reviewer, "evidence reviewer"),
    nodeId: boundedIdentity(identity.nodeId, "evidence node_id"),
    sessionId: boundedIdentity(identity.sessionId, "evidence session_id"),
    roundId: boundedIdentity(identity.roundId, "evidence round_id"),
    generation: boundedInteger(identity.generation, "evidence generation"),
    attempt: boundedInteger(identity.attempt, "evidence attempt"),
  };
}

function rowToRecord(row: {
  seq: number;
  schema_version: number;
  run_id: string;
  reviewer: string;
  node_id: string;
  session_id: string;
  round_id: string;
  generation: number;
  attempt: number;
  kind: ReviewEvidenceKind;
  dedup_key: string;
  payload_json: string;
  created_at: number;
}): ReviewEvidenceRecord {
  return {
    schemaVersion: row.schema_version as 1,
    identity: {
      runId: row.run_id,
      reviewer: row.reviewer,
      nodeId: row.node_id,
      sessionId: row.session_id,
      roundId: row.round_id,
      generation: row.generation,
      attempt: row.attempt,
    },
    kind: row.kind,
    dedupKey: row.dedup_key,
    payload: parseJsonRow<ReviewEvidenceRecord["payload"]>(row.payload_json),
    createdAt: row.created_at,
  };
}

function insertEvidence(
  identity: ReviewEvidenceIdentity,
  kind: ReviewEvidenceKind,
  dedupKey: string,
  payload: ReviewFindingV1 | AttemptDiagnosticV1 | ChangedFileCoverageAttestationV1,
  createdAt: number,
): ReviewEvidenceWriteResult {
  const db = getDb();
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, "utf8") > 131072) {
    throw new Error("review evidence payload exceeds 128 KiB");
  }
  const result = db.prepare(`
    INSERT OR IGNORE INTO dag_review_evidence(
      schema_version, run_id, reviewer, node_id, session_id, round_id,
      generation, attempt, kind, dedup_key, payload_json, created_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    identity.runId,
    identity.reviewer,
    identity.nodeId,
    identity.sessionId,
    identity.roundId,
    identity.generation,
    identity.attempt,
    kind,
    dedupKey,
    encoded,
    createdAt,
  );
  if (result.changes === 0) {
    return { status: "deduplicated" };
  }
  return {
    status: "inserted",
    record: {
      schemaVersion: 1,
      identity,
      kind,
      dedupKey,
      payload,
      createdAt,
    },
  };
}

/** Persist one bounded, redacted accepted finding (idempotent by finding id). */
export function recordReviewFinding(input: {
  identity: ReviewEvidenceIdentity;
  finding: unknown;
  createdAt?: number;
}): ReviewEvidenceWriteResult {
  const identity = validateIdentity(input.identity);
  const finding = normalizeReviewFinding(input.finding);
  if (!finding) throw new Error("review finding is invalid or exceeds bounded limits");
  return insertEvidence(
    identity,
    "finding",
    `finding:${finding.id}`,
    finding,
    input.createdAt ?? nowEpochMs(),
  );
}

/** Persist a compact coverage attestation (idempotent per round). */
export function recordReviewCoverage(input: {
  identity: ReviewEvidenceIdentity;
  attestation: unknown;
  createdAt?: number;
}): ReviewEvidenceWriteResult {
  const identity = validateIdentity(input.identity);
  if (!validateChangedFileCoverageAttestationShape(input.attestation).valid) {
    throw new Error("review coverage attestation is structurally invalid");
  }
  const attestation = input.attestation as ChangedFileCoverageAttestationV1;
  return insertEvidence(
    identity,
    "coverage",
    `coverage:${identity.roundId}`,
    attestation,
    input.createdAt ?? nowEpochMs(),
  );
}

/** Persist one bounded redacted attempt diagnostic (idempotent per attempt). */
export function recordAttemptDiagnostic(input: {
  identity: ReviewEvidenceIdentity;
  diagnostic: unknown;
  createdAt?: number;
}): ReviewEvidenceWriteResult {
  const identity = validateIdentity(input.identity);
  const diagnostic = sanitizeAttemptDiagnostic(input.diagnostic, { attempt: identity.attempt });
  if (!diagnostic || diagnostic.schema !== ATTEMPT_DIAGNOSTIC_SCHEMA_ID) {
    throw new Error("attempt diagnostic is invalid or exceeds bounded limits");
  }
  return insertEvidence(
    identity,
    "diagnostic",
    `attempt:${identity.attempt}`,
    diagnostic,
    input.createdAt ?? nowEpochMs(),
  );
}

/**
 * Persist everything carried by one accepted handoff: content findings,
 * coverage attestation, content diagnostics, and the transport diagnostic.
 */
export function recordReviewHandoffEvidence(
  identity: ReviewEvidenceIdentity,
  evidence: ReviewHandoffEvidenceInput,
): void {
  const validated = validateIdentity(identity);
  const safe = (write: () => ReviewEvidenceWriteResult): void => {
    try {
      write();
    } catch {
      // A single invalid item must never fail the authoritative handoff.
    }
  };
  for (const finding of evidence.submission?.findings ?? []) {
    safe(() => recordReviewFinding({ identity: validated, finding }));
  }
  if (evidence.submission?.coverage_attestation) {
    safe(() => recordReviewCoverage({
      identity: validated,
      attestation: evidence.submission?.coverage_attestation,
    }));
  }
  for (const diagnostic of evidence.submission?.diagnostics ?? []) {
    safe(() => recordAttemptDiagnostic({
      identity: validated,
      diagnostic: sanitizeAttemptDiagnostic(diagnostic, {
        attempt: validated.attempt,
        contract_stage: "handoff_applied",
      }),
    }));
  }
  if (evidence.transportDiagnostic !== undefined) {
    safe(() => recordAttemptDiagnostic({
      identity: validated,
      diagnostic: sanitizeAttemptDiagnostic(evidence.transportDiagnostic, {
        attempt: validated.attempt,
        failure_reason: evidence.failureReason,
        contract_stage: "handoff_applied",
      }),
    }));
  }
}

export function listReviewEvidenceRecords(
  runId: string,
  reviewer?: string,
): ReviewEvidenceRecord[] {
  const db = getDb();
  const rows = reviewer === undefined
    ? db.prepare(`
        SELECT seq, schema_version, run_id, reviewer, node_id, session_id,
          round_id, generation, attempt, kind, dedup_key, payload_json, created_at
        FROM dag_review_evidence
        WHERE run_id = ?
        ORDER BY seq
      `).all(runId)
    : db.prepare(`
        SELECT seq, schema_version, run_id, reviewer, node_id, session_id,
          round_id, generation, attempt, kind, dedup_key, payload_json, created_at
        FROM dag_review_evidence
        WHERE run_id = ? AND reviewer = ?
        ORDER BY seq
      `).all(runId, reviewer);
  return rows.map((row) => rowToRecord(row as Parameters<typeof rowToRecord>[0]));
}

/** Load accepted findings, attempt diagnostics, and coverage for one reviewer. */
export function loadReviewEvidence(runId: string, reviewer: string): LoadedReviewEvidence {
  const records = listReviewEvidenceRecords(runId, reviewer);
  const findings: ReviewFindingV1[] = [];
  const diagnostics: AttemptDiagnosticV1[] = [];
  let coverageAttestation: ChangedFileCoverageAttestationV1 | null = null;
  for (const record of records) {
    if (record.kind === "finding" && !findings.some((item) => item.id === (record.payload as ReviewFindingV1).id)) {
      findings.push(record.payload as ReviewFindingV1);
    } else if (record.kind === "diagnostic") {
      diagnostics.push(record.payload as AttemptDiagnosticV1);
    } else if (record.kind === "coverage") {
      coverageAttestation = record.payload as ChangedFileCoverageAttestationV1;
    }
  }
  return {
    findings,
    diagnostics,
    ...(coverageAttestation ? { coverageAttestation } : {}),
  };
}

/** Build the bounded correction/normalization projection for one reviewer. */
export function buildReviewEvidenceProjectionFor(
  runId: string,
  reviewer: string,
): ReviewEvidenceProjectionV1 | undefined {
  const loaded = loadReviewEvidence(runId, reviewer);
  return buildReviewEvidenceProjection({
    reviewer,
    findings: loaded.findings,
    diagnostics: loaded.diagnostics,
    coverage_attestation: loaded.coverageAttestation ?? null,
  });
}

function safeRunWorkspace(runId: string): string | undefined {
  const home = getHomerailHome();
  const workspaceRoot = path.resolve(home, "workspace");
  const segments = runId.split("/").filter((segment) => /^[A-Za-z0-9._-]+$/.test(segment));
  if (segments.length === 0 || segments.join("/") !== runId) return undefined;
  const candidate = path.resolve(workspaceRoot, ...segments);
  const relative = path.relative(workspaceRoot, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return candidate;
}

/**
 * Mirror a bounded redacted evidence projection into the run workspace so
 * deterministic command normalizers can consume Manager-owned evidence
 * without trusting a later truncated handoff.
 */
export function writeReviewEvidenceProjectionFile(runId: string, reviewer: string): boolean {
  try {
    const projection = buildReviewEvidenceProjectionFor(runId, reviewer);
    if (!projection) return false;
    const runWorkspace = safeRunWorkspace(runId);
    if (!runWorkspace) return false;
    const evidenceDir = path.join(runWorkspace, "review-evidence");
    fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    const target = path.join(evidenceDir, "projection.json");
    fs.writeFileSync(target, JSON.stringify(projection), { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(evidenceDir, 0o700);
      fs.chmodSync(target, 0o600);
    } catch {
      // Best-effort permissions on platforms without POSIX modes.
    }
    return true;
  } catch {
    return false;
  }
}

/** Build the workspace projection path for a run/reviewer (read-only helper). */
export function reviewEvidenceProjectionPath(runId: string, reviewer: string): string | undefined {
  const runWorkspace = safeRunWorkspace(runId);
  if (!runWorkspace) return undefined;
  return path.join(runWorkspace, "review-evidence", "projection.json");
}

export { REVIEW_EVIDENCE_PROJECTION_SCHEMA_ID, extractReviewEvidence };

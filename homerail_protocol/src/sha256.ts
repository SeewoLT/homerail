/**
 * Deterministic SHA-256 helpers for HomeRail run evidence.
 *
 * Coverage and deduplication digests must be stable across processes and
 * provider outputs. All digests are lowercase hexadecimal.
 * @version 0.1.0
 */

import { createHash } from "node:crypto";

/** Lowercase SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Canonical sorted, de-duplicated changed-file set. */
export function canonicalChangedFiles(files: readonly unknown[]): string[] {
  const unique = new Set<string>();
  for (const file of files) {
    if (typeof file !== "string") continue;
    const normalized = file.trim();
    if (!normalized) continue;
    unique.add(normalized);
  }
  return Array.from(unique).sort();
}

/**
 * Deterministic digest/count pair for a trusted changed-file inventory.
 *
 * The digest is computed over the canonical sorted unique path set, so model
 * attestations never need to echo the full list and ordering changes cannot
 * forge coverage.
 */
export function changedFileCoverageDigest(files: readonly unknown[]): {
  digest: string;
  count: number;
} {
  const canonical = canonicalChangedFiles(files);
  return {
    digest: sha256Hex(canonical.join("\n")),
    count: canonical.length,
  };
}

/** Build the compact coverage attestation value for a trusted file list. */
export function changedFileCoverageAttestation(
  files: readonly unknown[],
): { schema: "changed-file-coverage-v1"; digest: string; count: number } {
  const { digest, count } = changedFileCoverageDigest(files);
  return { schema: "changed-file-coverage-v1", digest, count };
}

/** Stable deduplication key for one review finding. */
export function reviewFindingDedupKey(file: string, line: number, title: string): string {
  return sha256Hex(`${file}\0${line}\0${title}`);
}

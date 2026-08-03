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
 * Canonical algorithm: trim each path, drop blanks and duplicates, sort the
 * remaining paths ascending, join them with "\n", and SHA-256 the result.
 * The PR-review prepare node and strict attestation validation must both use
 * this exact algorithm, so equivalent changed-file sets produce the same
 * digest/count regardless of input order or duplicates.
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

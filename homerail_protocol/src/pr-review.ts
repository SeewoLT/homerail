/**
 * Shared PR Review scenario primitives.
 * @version 0.1.0
 */

const FULL_GIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** Accept only complete SHA-1 or SHA-256 Git object identifiers. */
export function isFullGitRevision(value: unknown): value is string {
  return typeof value === "string" && FULL_GIT_REVISION.test(value);
}

import { describe, expect, it } from "vitest";

import { isFullGitRevision } from "../src/pr-review.js";

describe("isFullGitRevision", () => {
  it("accepts full SHA-1 and SHA-256 revisions only", () => {
    expect(isFullGitRevision("a".repeat(40))).toBe(true);
    expect(isFullGitRevision("B".repeat(64))).toBe(true);
    expect(isFullGitRevision("a".repeat(39))).toBe(false);
    expect(isFullGitRevision("a".repeat(41))).toBe(false);
    expect(isFullGitRevision("g".repeat(40))).toBe(false);
  });
});

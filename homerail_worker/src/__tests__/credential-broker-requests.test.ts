import { describe, expect, it } from "vitest";

import { CredentialBrokerRequestRegistry } from "../credential-broker-requests.js";

function request(id: string) {
  return {
    request_id: id,
    run_id: "run",
    node_id: "aggregate",
    session_id: "session",
    credential_ref: "github-autofix",
    broker: "github_pr",
    action: "commit_workspace",
    input: {},
  };
}

describe("CredentialBrokerRequestRegistry", () => {
  it("waits for the Manager result without a local action timeout", async () => {
    const registry = new CredentialBrokerRequestRegistry();
    const sent: string[] = [];
    const pending = registry.call(request("request-1"), (payload) => sent.push(payload));

    expect(registry.size).toBe(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({
      type: "credential_broker_call",
      data: { request_id: "request-1", action: "commit_workspace" },
    });
    expect(registry.settle({
      request_id: "request-1",
      ok: true,
      result: { head_sha: "a".repeat(40), manifest_sha256: "b".repeat(64) },
    })).toBe(true);
    await expect(pending).resolves.toMatchObject({
      request_id: "request-1",
      ok: true,
      result: { manifest_sha256: "b".repeat(64) },
    });
    expect(registry.size).toBe(0);
  });

  it("settles outstanding requests only when the Worker connection closes", async () => {
    const registry = new CredentialBrokerRequestRegistry();
    const pending = registry.call(request("request-2"), () => {});

    registry.close("connection closed");

    await expect(pending).resolves.toEqual({
      request_id: "request-2",
      ok: false,
      error: "connection closed",
    });
    expect(registry.size).toBe(0);
  });
});

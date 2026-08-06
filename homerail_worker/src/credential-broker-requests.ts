import type {
  DagCredentialBrokerCallRequest,
  DagCredentialBrokerCallResult,
} from "homerail-protocol";

type PendingRequest = {
  resolve: (result: DagCredentialBrokerCallResult) => void;
};

/**
 * Tracks Manager-broker requests for the lifetime of the Worker connection.
 *
 * Broker actions can legitimately take longer than an arbitrary local timer
 * (for example, an atomic GitHub commit that uploads many blobs). The Manager
 * owns action completion and durable receipts, so the Worker waits for the
 * matching result or connection shutdown instead of inventing a timeout.
 */
export class CredentialBrokerRequestRegistry {
  private readonly pending = new Map<string, PendingRequest>();

  call(
    request: DagCredentialBrokerCallRequest,
    send: (payload: string) => void,
  ): Promise<DagCredentialBrokerCallResult> {
    return new Promise((resolve) => {
      if (this.pending.has(request.request_id)) {
        resolve({
          request_id: request.request_id,
          ok: false,
          error: "Duplicate credential broker request id",
        });
        return;
      }
      this.pending.set(request.request_id, { resolve });
      try {
        send(JSON.stringify({ type: "credential_broker_call", data: request }));
      } catch {
        this.pending.delete(request.request_id);
        resolve({
          request_id: request.request_id,
          ok: false,
          error: "Credential broker request could not be sent",
        });
      }
    });
  }

  settle(result: DagCredentialBrokerCallResult): boolean {
    const pending = this.pending.get(result.request_id);
    if (!pending) return false;
    this.pending.delete(result.request_id);
    pending.resolve(result);
    return true;
  }

  close(error = "Worker shutting down"): void {
    for (const [requestId, pending] of this.pending) {
      pending.resolve({ request_id: requestId, ok: false, error });
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}

import type WebSocket from "ws";
import type { WorkerRuntimeIdentity } from "homerail-protocol";

export interface WorkerState {
  worker_id: string;
  project_id: string;
  socket: WebSocket;
  status: string;
  capabilities: string[];
  runtime_identity?: WorkerRuntimeIdentity;
  registered_at: number;
  last_heartbeat: number;
}

const registry = new Map<string, WorkerState>();

export function registerWorker(state: WorkerState): void {
  registry.set(state.worker_id, state);
}

export function unregisterWorker(worker_id: string): void {
  registry.delete(worker_id);
}

export function getWorker(worker_id: string): WorkerState | undefined {
  return registry.get(worker_id);
}

export function getAllWorkers(): WorkerState[] {
  return Array.from(registry.values());
}

export function updateHeartbeat(worker_id: string): void {
  const worker = registry.get(worker_id);
  if (worker) {
    worker.last_heartbeat = Date.now();
  }
}

export function _clearWorkers(): void {
  registry.clear();
}

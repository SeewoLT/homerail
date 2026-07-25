/**
 * Browser-safe constants shared by the CLI, Manager, Worker, and Agent UI
 * when describing the local DAG Worker runtime.
 *
 * Keep filesystem and hashing implementations out of this package so the
 * protocol barrel remains safe to bundle in the browser.
 * @version 0.1.0
 */
export const HOMERAIL_WORKER_IMAGE = "homerail-worker:latest";
export const HOMERAIL_WORKER_SOURCE_LABEL = "org.homerail.worker.source_fingerprint";
export const HOMERAIL_WORKER_PROTOCOL_LABEL = "org.homerail.worker.protocol_version";
export const HOMERAIL_WORKER_VERSION_LABEL = "org.opencontainers.image.version";
export const HOMERAIL_WORKER_REVISION_LABEL = "org.opencontainers.image.revision";
export const HOMERAIL_WORKER_CREATED_LABEL = "org.opencontainers.image.created";

export interface WorkerRuntimeIdentity {
  worker_version?: string;
  protocol_version?: string;
  source_fingerprint?: string;
  image_revision?: string;
}

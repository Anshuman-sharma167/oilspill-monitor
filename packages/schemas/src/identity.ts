import { createHash } from "node:crypto";

import type { AlertDelivery, ProcessingJob, Scene } from "./generated.js";

const stableId = (prefix: string, parts: readonly string[]): string =>
  `${prefix}:${createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 32)}`;

export const processingJobId = (
  sceneId: string,
  aoiId: string,
  preprocessingVersion: string,
  modelVersion: string,
): string =>
  stableId("job", [sceneId, aoiId, preprocessingVersion, modelVersion]);

export const candidateId = (jobId: string, detectionKey: string): string =>
  stableId("candidate", [jobId, detectionKey]);

export const sceneId = (provider: string, providerSceneId: string): string =>
  stableId("scene", [provider, providerSceneId]);

export const alertDeliveryId = (
  candidateIdentifier: string,
  reviewId: string,
  channel: string,
): string => stableId("delivery", [candidateIdentifier, reviewId, channel]);

export const upsertDiscoveredScene = (
  scenes: Map<string, Scene>,
  incoming: Scene,
): Scene => {
  const key = `${incoming.provider}\u001f${incoming.provider_scene_id}`;
  const existing = scenes.get(key);
  if (existing !== undefined) {
    existing.last_discovered_at = incoming.last_discovered_at;
    return existing;
  }
  scenes.set(key, incoming);
  return incoming;
};

export const ensureProcessingJob = (
  jobs: Map<string, ProcessingJob>,
  incoming: ProcessingJob,
): ProcessingJob => {
  const immutableId = processingJobId(
    incoming.scene_id,
    incoming.aoi_id,
    incoming.preprocessing_version,
    incoming.model_version,
  );
  const existing = jobs.get(immutableId);
  if (existing !== undefined) return existing;
  if (incoming.job_id !== immutableId)
    throw new Error("job_id does not match its immutable identity fields");
  jobs.set(immutableId, incoming);
  return incoming;
};

export const ensureAlertDelivery = (
  deliveries: Map<string, AlertDelivery>,
  incoming: AlertDelivery,
): AlertDelivery => {
  const immutableId = alertDeliveryId(
    incoming.candidate_id,
    incoming.review_id,
    incoming.channel,
  );
  const existing = deliveries.get(immutableId);
  if (existing !== undefined) return existing;
  if (incoming.delivery_id !== immutableId)
    throw new Error("delivery_id does not match its approval identity fields");
  deliveries.set(immutableId, incoming);
  return incoming;
};

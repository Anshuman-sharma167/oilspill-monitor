// Generated from packages/schemas/schema/contracts.schema.json. Do not edit.
export const contractSchemaVersion = "1.0.0" as const;
export const contractModelNames = ["AOI","Scene","ProcessingJob","ModelVersion","Candidate","CandidateAsset","Review","AlertDelivery"] as const;

export type Identifier = string;

export type Version = string;

export type Timestamp = string;

export type NullableTimestamp = Timestamp | null;

export type Position = [number, number];

export type LinearRing = Array<Position>;

export type PolygonCoordinates = Array<LinearRing>;

export type GeoJSONGeometry = { "type": "Polygon"; "coordinates": PolygonCoordinates; } | { "type": "MultiPolygon"; "coordinates": Array<PolygonCoordinates>; };

export interface Failure {
  "code": "OPENEO_TIMEOUT" | "WORKER_INTERRUPTED" | "CORRUPTED_OUTPUT" | "CONTRACT_VALIDATION_FAILED" | "INTERNAL_ERROR";
  "stage": "discovery" | "preprocessing" | "inferencing" | "storage";
  "retryable": boolean;
  "detail": string;
}

export interface AOI {
  "kind": "AOI";
  "schema_version": "1.0.0";
  "aoi_id": Identifier;
  "name": string;
  "geometry": GeoJSONGeometry;
  "external_crs": "EPSG:4326";
  "created_at": Timestamp;
}

export interface Scene {
  "kind": "Scene";
  "schema_version": "1.0.0";
  "scene_id": Identifier;
  "provider": string;
  "provider_scene_id": string;
  "acquired_at": Timestamp;
  "footprint": GeoJSONGeometry;
  "external_crs": "EPSG:4326";
  "first_discovered_at": Timestamp;
  "last_discovered_at": Timestamp;
}

export interface ProcessingJob {
  "kind": "ProcessingJob";
  "schema_version": "1.0.0";
  "job_id": Identifier;
  "scene_id": Identifier;
  "aoi_id": Identifier;
  "preprocessing_version": Version;
  "model_version": Version;
  "state": "discovered" | "queued" | "preprocessing" | "inferencing" | "ready_for_review" | "failed" | "deferred_quota";
  "discovered_at": Timestamp;
  "queued_at": NullableTimestamp;
  "preprocessing_at": NullableTimestamp;
  "inferencing_at": NullableTimestamp;
  "ready_for_review_at": NullableTimestamp;
  "failed_at": NullableTimestamp;
  "deferred_quota_at": NullableTimestamp;
  "failure": Failure | null;
}

export interface ModelVersion {
  "kind": "ModelVersion";
  "schema_version": "1.0.0";
  "model_version": Version;
  "artifact_sha256": string;
  "input_contract_version": Version;
  "created_at": Timestamp;
}

export interface Candidate {
  "kind": "Candidate";
  "schema_version": "1.0.0";
  "candidate_id": Identifier;
  "job_id": Identifier;
  "detection_key": Identifier;
  "display_rank": number;
  "geometry": GeoJSONGeometry;
  "external_crs": "EPSG:4326";
  "assessment": "oil-like slick candidate" | "likely slick" | "look-alike" | "uncertain";
  "review_status": "pending_manual_review" | "approved" | "rejected";
  "created_at": Timestamp;
}

export interface CandidateAsset {
  "kind": "CandidateAsset";
  "schema_version": "1.0.0";
  "asset_id": Identifier;
  "candidate_id": Identifier;
  "asset_type": "context_webp" | "detail_webp" | "probability_cog" | "mask_cog" | "report_json";
  "layout_version": "1.0.0";
  "media_type": "image/webp" | "image/tiff; application=geotiff" | "application/json";
  "uri": string;
  "sha256": string;
  "created_at": Timestamp;
}

export interface Review {
  "kind": "Review";
  "schema_version": "1.0.0";
  "review_id": Identifier;
  "candidate_id": Identifier;
  "reviewer_id": Identifier;
  "revision": number;
  "decision": "approved" | "rejected" | "needs_more_information";
  "reviewed_at": Timestamp;
}

export interface AlertDelivery {
  "kind": "AlertDelivery";
  "schema_version": "1.0.0";
  "delivery_id": Identifier;
  "candidate_id": Identifier;
  "review_id": Identifier;
  "channel": "telegram";
  "state": "approved" | "sending" | "delivered" | "retryable_failure";
  "attempt_count": number;
  "approved_at": Timestamp;
  "delivered_at": NullableTimestamp;
}

export type ContractModel = AOI | Scene | ProcessingJob | ModelVersion | Candidate | CandidateAsset | Review | AlertDelivery;

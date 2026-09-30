"""Generated from contracts.schema.json. Do not edit."""

from typing import Literal, TypeAlias, TypedDict

CONTRACT_SCHEMA_VERSION = "1.0.0"
CONTRACT_MODEL_NAMES = [
    "AOI",
    "Scene",
    "ProcessingJob",
    "ModelVersion",
    "Candidate",
    "CandidateAsset",
    "Review",
    "AlertDelivery",
]

Identifier: TypeAlias = str

Version: TypeAlias = str

Timestamp: TypeAlias = str

NullableTimestamp: TypeAlias = Timestamp | None

NullableNumber: TypeAlias = float | None

Position: TypeAlias = tuple[float, float]

LinearRing: TypeAlias = list[Position]

PolygonCoordinates: TypeAlias = list[LinearRing]

GeoJSONGeometry: TypeAlias = dict[str, object] | dict[str, object]


class Failure(TypedDict):
    code: Literal[
        "OPENEO_TIMEOUT",
        "WORKER_INTERRUPTED",
        "CORRUPTED_OUTPUT",
        "CONTRACT_VALIDATION_FAILED",
        "INTERNAL_ERROR",
    ]
    stage: Literal["discovery", "preprocessing", "inferencing", "storage"]
    retryable: bool
    detail: str


class AOI(TypedDict):
    kind: Literal["AOI"]
    schema_version: Literal["1.0.0"]
    aoi_id: Identifier
    name: str
    geometry: GeoJSONGeometry
    external_crs: Literal["EPSG:4326"]
    enabled: bool
    priority: Literal["P0", "P1", "P2"]
    valid_from: Timestamp
    valid_to: NullableTimestamp
    policy_version: Version
    dry_run_month: str
    estimated_scene_count: int
    approximate_openeo_credits: NullableNumber
    cost_estimate_status: Literal["estimated", "pending_provider_run"]
    cost_estimate_method: str
    cost_estimated_at: Timestamp
    water_mask_source: str
    coverage_status: Literal["covered", "disabled", "deferred", "failed", "unobserved"]
    created_at: Timestamp


class Scene(TypedDict):
    kind: Literal["Scene"]
    schema_version: Literal["1.0.0"]
    scene_id: Identifier
    provider: str
    provider_scene_id: str
    acquired_at: Timestamp
    footprint: GeoJSONGeometry
    external_crs: Literal["EPSG:4326"]
    first_discovered_at: Timestamp
    last_discovered_at: Timestamp


class ProcessingJob(TypedDict):
    kind: Literal["ProcessingJob"]
    schema_version: Literal["1.0.0"]
    job_id: Identifier
    scene_id: Identifier
    aoi_id: Identifier
    preprocessing_version: Version
    model_version: Version
    state: Literal[
        "discovered",
        "queued",
        "preprocessing",
        "inferencing",
        "ready_for_review",
        "failed",
        "deferred_quota",
    ]
    discovered_at: Timestamp
    queued_at: NullableTimestamp
    preprocessing_at: NullableTimestamp
    inferencing_at: NullableTimestamp
    ready_for_review_at: NullableTimestamp
    failed_at: NullableTimestamp
    deferred_quota_at: NullableTimestamp
    failure: Failure | None


class ModelVersion(TypedDict):
    kind: Literal["ModelVersion"]
    schema_version: Literal["1.0.0"]
    model_version: Version
    artifact_sha256: str
    input_contract_version: Version
    created_at: Timestamp


class Candidate(TypedDict):
    kind: Literal["Candidate"]
    schema_version: Literal["1.0.0"]
    candidate_id: Identifier
    job_id: Identifier
    detection_key: Identifier
    display_rank: int
    geometry: GeoJSONGeometry
    external_crs: Literal["EPSG:4326"]
    assessment: Literal[
        "oil-like slick candidate", "likely slick", "look-alike", "uncertain"
    ]
    review_status: Literal["pending_manual_review", "approved", "rejected"]
    created_at: Timestamp


class CandidateAsset(TypedDict):
    kind: Literal["CandidateAsset"]
    schema_version: Literal["1.0.0"]
    asset_id: Identifier
    candidate_id: Identifier
    asset_type: Literal[
        "context_webp", "detail_webp", "probability_cog", "mask_cog", "report_json"
    ]
    layout_version: Literal["1.0.0"]
    media_type: Literal[
        "image/webp", "image/tiff; application=geotiff", "application/json"
    ]
    uri: str
    sha256: str
    created_at: Timestamp


class Review(TypedDict):
    kind: Literal["Review"]
    schema_version: Literal["1.0.0"]
    review_id: Identifier
    candidate_id: Identifier
    reviewer_id: Identifier
    revision: int
    decision: Literal["approved", "rejected", "needs_more_information"]
    reviewed_at: Timestamp


class AlertDelivery(TypedDict):
    kind: Literal["AlertDelivery"]
    schema_version: Literal["1.0.0"]
    delivery_id: Identifier
    candidate_id: Identifier
    review_id: Identifier
    channel: Literal["telegram"]
    state: Literal["approved", "sending", "delivered", "retryable_failure"]
    attempt_count: int
    approved_at: Timestamp
    delivered_at: NullableTimestamp


ContractModel: TypeAlias = (
    AOI
    | Scene
    | ProcessingJob
    | ModelVersion
    | Candidate
    | CandidateAsset
    | Review
    | AlertDelivery
)

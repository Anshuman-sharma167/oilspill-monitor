# Shared architecture contracts

`packages/schemas/schema/contracts.schema.json` is the single canonical source
for `AOI`, `Scene`, `ProcessingJob`, `ModelVersion`, `Candidate`,
`CandidateAsset`, `Review`, and `AlertDelivery`. Its contract version is
`1.0.0`. `npm run types:generate` creates the checked-in Python and TypeScript
models; `npm run types:check` fails when either output differs from the source.
Both runtimes validate the same valid and invalid fixtures.

## Job identity and state

A job is identified by the ordered tuple
`scene_id + aoi_id + preprocessing_version + model_version`. The derived
`job_id` is a SHA-256-based opaque identifier, and the database also has a
unique constraint on the four source fields. Those fields cannot be updated.

The only states are `discovered`, `queued`, `preprocessing`, `inferencing`,
`ready_for_review`, `failed`, and `deferred_quota`. Each state has a matching
`*_at` timestamp. Successful-path timestamps are monotonic. A failed job has a
`failed_at` timestamp and a structured failure containing `code`, `stage`,
`retryable`, and a bounded non-secret `detail`; nonfailed jobs cannot carry
failure data.

Candidates use `candidate_id = hash(job_id + detection_key)`. `display_rank` is
presentation data and is deliberately absent from that identity. Reranking can
change `display_rank` without changing review or alert references.

## Geometry boundary

External geometry is RFC 7946 GeoJSON `Polygon` or `MultiPolygon` with
longitude/latitude coordinates and the explicit contract value `EPSG:4326`.
Legacy GeoJSON `crs` members, projected coordinate pairs, out-of-range
longitude/latitude, and open linear rings are rejected.

Area, length, buffer, and distance calculations must never operate directly on
EPSG:4326 degrees. A processing stage selects a suitable projected CRS for the
AOI (for example, its local UTM zone or an explicitly chosen equal-area CRS),
performs metric calculations there, and transforms the result back to EPSG:4326
before contract validation, database storage, or API output. The selected
internal CRS belongs in processing provenance, not in external geometry.

## Asset layout version 1.0.0

Assets are private and content-addressed with SHA-256. Their object key root is
`contracts/v1/candidates/{candidate_id}/assets/v1/`. A new incompatible layout
requires a new `layout_version` and path segment; existing objects are not
rewritten in place.

| Asset type        | Relative object key | Media type                        | Version 1 content                                                                                                                                           |
| ----------------- | ------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context_webp`    | `context.webp`      | `image/webp`                      | North-up RGB review context with the candidate outline; no coordinates in labels or public metadata.                                                        |
| `detail_webp`     | `detail.webp`       | `image/webp`                      | North-up RGB close view of the same candidate and acquisition; no ranking in the filename.                                                                  |
| `probability_cog` | `probability.tif`   | `image/tiff; application=geotiff` | Tiled, internally over-viewed single-band float probability in `[0,1]`, with nodata and georeferencing.                                                     |
| `mask_cog`        | `mask.tif`          | `image/tiff; application=geotiff` | Tiled, internally over-viewed single-band unsigned-byte mask (`0` background, `1` candidate, nodata `255`) with georeferencing.                             |
| `report_json`     | `report.json`       | `application/json`                | UTF-8 JSON summary containing contract/layout versions, immutable IDs, checksums of sibling assets, processing provenance, and no credential or signed URL. |

The schema fixes the five asset names, layout version, and allowed media types;
runtime validation also enforces the type-to-media mapping. Object URIs remain
private references. Public fixtures use only reserved synthetic examples.

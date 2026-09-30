# Part 5 idempotency rules

Every event handler may receive the same event more than once. A handler must
commit its durable record before acknowledging an event and return the existing
record on a matching idempotency key.

## Repeated discovery

- Key: `(provider, provider_scene_id)`.
- First call: derive `scene_id`, insert the scene, and set both discovery
  timestamps.
- Repeat: update only mutable discovery metadata such as `last_discovered_at`;
  return the existing `scene_id`.
- Enforcement: `scenes_provider_identity_key` plus the shared
  `upsertDiscoveredScene` behavior.

## Retried worker or dispatcher

- Key: `(scene_id, aoi_id, preprocessing_version, model_version)`.
- First call: derive `job_id` from exactly those values and insert the job.
- Repeat: return the existing job. Resume only from its persisted state; never
  create another job or reset completed transition timestamps.
- Enforcement: `processing_jobs_immutable_identity_key`, an update trigger that
  rejects identity changes, and `ensureProcessingJob`.

Writing an asset is also retry-safe: use the versioned candidate asset path,
write to a temporary object, validate media/layout/checksum, then atomically
publish or retain an existing object with the same checksum. A different
checksum at the same immutable asset key is `CORRUPTED_OUTPUT`, not an
overwrite.

## Repeated alert approval

- Key: `(candidate_id, review_id, channel)`.
- First call: derive `delivery_id`, insert an approved delivery, and enqueue one
  send attempt.
- Repeat: return the existing delivery, including its current attempt count and
  result. Do not enqueue another logical delivery merely because approval was
  replayed.
- Enforcement: `alert_deliveries_approval_key` and `ensureAlertDelivery`.

Transport retries update the existing delivery and increment `attempt_count`.
They never create a new delivery identity. A successful provider response sets
`delivered_at`; later retries return that delivered record without contacting
the provider again.

## Stable candidate identity

Candidate identity is `(job_id, detection_key)`. `display_rank` is mutable and
is excluded from the key. Database uniqueness and the `candidateId` helper make
review and alert history stable when scores are reranked.

create schema if not exists app_private;

revoke all on schema app_private from public, anon, authenticated;

create type app_private.processing_job_state as enum (
    'discovered',
    'queued',
    'preprocessing',
    'inferencing',
    'ready_for_review',
    'failed',
    'deferred_quota'
);

create table app_private.scenes (
    scene_id text primary key,
    source_provider text not null,
    provider_scene_id text not null,
    first_discovered_at timestamptz not null,
    last_discovered_at timestamptz not null,
    constraint scenes_provider_identity_key unique (
        source_provider,
        provider_scene_id
    ),
    constraint scenes_discovery_order_check check (
        last_discovered_at >= first_discovered_at
    )
);

create table app_private.processing_jobs (
    job_id text primary key,
    scene_id text not null references app_private.scenes (scene_id),
    aoi_id text not null,
    preprocessing_version text not null,
    model_version text not null,
    state app_private.processing_job_state not null,
    discovered_at timestamptz not null,
    queued_at timestamptz,
    preprocessing_at timestamptz,
    inferencing_at timestamptz,
    ready_for_review_at timestamptz,
    failed_at timestamptz,
    deferred_quota_at timestamptz,
    failure jsonb,
    constraint processing_jobs_immutable_identity_key unique (
        scene_id,
        aoi_id,
        preprocessing_version,
        model_version
    ),
    constraint processing_jobs_failure_shape_check check (
        (
            state = 'failed'
            and failed_at is not null
            and jsonb_typeof(failure) = 'object'
            and failure ?& array['code', 'stage', 'retryable', 'detail']
            and failure ->> 'code' in (
                'OPENEO_TIMEOUT',
                'WORKER_INTERRUPTED',
                'CORRUPTED_OUTPUT',
                'CONTRACT_VALIDATION_FAILED',
                'INTERNAL_ERROR'
            )
        )
        or (
            state <> 'failed'
            and failed_at is null
            and failure is null
        )
    ),
    constraint processing_jobs_state_timestamp_check check (
        (state = 'discovered')
        or (state = 'queued' and queued_at is not null)
        or (
            state = 'preprocessing'
            and queued_at is not null
            and preprocessing_at is not null
        )
        or (
            state = 'inferencing'
            and queued_at is not null
            and preprocessing_at is not null
            and inferencing_at is not null
        )
        or (
            state = 'ready_for_review'
            and queued_at is not null
            and preprocessing_at is not null
            and inferencing_at is not null
            and ready_for_review_at is not null
        )
        or (state = 'failed' and failed_at is not null)
        or (state = 'deferred_quota' and deferred_quota_at is not null)
    )
);

create table app_private.candidates (
    candidate_id text primary key,
    job_id text not null references app_private.processing_jobs (job_id),
    detection_key text not null,
    display_rank integer not null check (display_rank > 0),
    constraint candidates_stable_detection_key unique (job_id, detection_key),
    constraint candidates_display_rank_key unique (job_id, display_rank)
);

create table app_private.alert_deliveries (
    delivery_id text primary key,
    candidate_id text not null references app_private.candidates (candidate_id),
    review_id text not null,
    channel text not null check (channel = 'telegram'),
    approved_at timestamptz not null,
    constraint alert_deliveries_approval_key unique (
        candidate_id,
        review_id,
        channel
    )
);

alter table app_private.scenes enable row level security;
alter table app_private.processing_jobs enable row level security;
alter table app_private.candidates enable row level security;
alter table app_private.alert_deliveries enable row level security;

create function app_private.reject_processing_job_identity_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if row(
        old.scene_id,
        old.aoi_id,
        old.preprocessing_version,
        old.model_version
    ) is distinct from row(
        new.scene_id,
        new.aoi_id,
        new.preprocessing_version,
        new.model_version
    ) then
        raise exception 'processing job identity fields are immutable'
            using errcode = '23514';
    end if;
    return new;
end;
$$;

create trigger processing_jobs_reject_identity_change
before update on app_private.processing_jobs
for each row
execute function app_private.reject_processing_job_identity_change();

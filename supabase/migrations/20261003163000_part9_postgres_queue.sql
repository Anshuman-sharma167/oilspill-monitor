create type app_private.processing_stage as enum (
    'preprocessing',
    'inferencing',
    'asset_upload'
);

alter table app_private.processing_jobs
add column priority app_private.aoi_priority,
add column attempt_count integer not null default 0,
add column max_attempts integer not null default 3,
add column next_attempt_at timestamptz,
add column claimed_by text,
add column claim_token uuid,
add column claimed_at timestamptz,
add column lease_expires_at timestamptz,
add column updated_at timestamptz not null default now(),
add column error_code text,
add column error_detail text,
add column provider_job_id text;

alter table app_private.processing_jobs
drop constraint processing_jobs_failure_shape_check;

alter table app_private.processing_jobs
add constraint processing_jobs_failure_shape_check check (
    (
        state = 'failed'
        and failed_at is not null
        and jsonb_typeof(failure) = 'object'
        and failure ?& array['code', 'stage', 'retryable', 'detail']
        and failure ->> 'code' in (
            'OPENEO_TIMEOUT', 'WORKER_INTERRUPTED', 'CORRUPTED_OUTPUT',
            'CONTRACT_VALIDATION_FAILED', 'INTERNAL_ERROR',
            'PROVIDER_JOB_FAILED', 'PROVIDER_JOB_CANCELLED',
            'NETWORK_TIMEOUT', 'TEMPORARY_PROVIDER_FAILURE',
            'GITHUB_TRANSIENT_FAILURE', 'TEMPORARY_STORAGE_FAILURE',
            'UNSUPPORTED_POLARIZATION', 'INVALID_GEOMETRY',
            'INVALID_CONFIGURATION', 'PROVIDER_STATUS_UNAVAILABLE'
        )
    )
    or (
        state <> 'failed'
        and failed_at is null
        and failure is null
    )
);

update app_private.processing_jobs as job
set priority = coalesce(
    (
        select aoi.priority
        from app_private.aois as aoi
        where aoi.aoi_id = job.aoi_id
        order by aoi.valid_from desc, aoi.policy_version desc
        limit 1
    ),
    'P2'::app_private.aoi_priority
);

alter table app_private.processing_jobs
alter column priority set not null,
alter column priority drop default,
add constraint processing_jobs_attempt_count_check check (
    attempt_count >= 0 and attempt_count <= max_attempts
),
add constraint processing_jobs_max_attempts_check check (
    max_attempts between 1 and 10
),
add constraint processing_jobs_claimed_by_check check (
    claimed_by is null
    or claimed_by ~ '^[a-z0-9][a-z0-9._:-]{2,127}$'
),
add constraint processing_jobs_claim_fields_check check (
    (
        claimed_by is null and claim_token is null and claimed_at is null
        and lease_expires_at is null
    )
    or (
        claimed_by is not null and claim_token is not null
        and claimed_at is not null and lease_expires_at is not null
        and lease_expires_at > claimed_at
    )
),
add constraint processing_jobs_error_code_check check (
    error_code is null or (
        length(error_code) between 3 and 64
        and error_code ~ '^[A-Z][A-Z0-9_]+$'
    )
),
add constraint processing_jobs_error_detail_check check (
    error_detail is null
    or (
        length(error_detail) between 1 and 500
        and error_detail !~* (
            '(token|secret|password|authorization|cookie|'
            || 'signed[ _-]?url|coordinates?)'
        )
    )
),
add constraint processing_jobs_provider_job_id_check check (
    provider_job_id is null
    or (
        length(provider_job_id) between 3 and 200
        and provider_job_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
    )
),
add constraint processing_jobs_queue_state_check check (
    (
        state in ('preprocessing', 'inferencing')
        and claimed_by is not null
    )
    or (
        state not in ('preprocessing', 'inferencing')
        and claimed_by is null
    )
),
add constraint processing_jobs_next_attempt_check check (
    state = 'queued' or next_attempt_at is null
);

create function app_private.snapshot_processing_job_priority()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_priority app_private.aoi_priority;
begin
    select aoi.priority into v_priority
    from app_private.aois as aoi
    where aoi.aoi_id = new.aoi_id
      and aoi.valid_from <= new.discovered_at
      and (aoi.valid_to is null or new.discovered_at < aoi.valid_to)
    order by aoi.valid_from desc, aoi.policy_version desc
    limit 1;
    new.priority := coalesce(
        v_priority,
        new.priority,
        'P2'::app_private.aoi_priority
    );
    return new;
end;
$$;

create trigger processing_jobs_snapshot_priority
before insert on app_private.processing_jobs
for each row
execute function app_private.snapshot_processing_job_priority();

update app_private.processing_jobs as job
set provider_job_id = run.provider_job_id
from app_private.provider_job_runs as run
where run.job_id = job.job_id and run.provider_job_id is not null;

create index processing_jobs_claim_queue
on app_private.processing_jobs (
    next_attempt_at,
    priority,
    queued_at,
    job_id
)
where state = 'queued' and attempt_count < max_attempts;

create table app_private.processing_stage_checkpoints (
    job_id text not null references app_private.processing_jobs (job_id),
    stage_name app_private.processing_stage not null,
    stage_version text not null check (
        stage_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
    ),
    content_checksum text not null check (
        content_checksum ~ '^[0-9a-f]{64}$'
    ),
    metadata jsonb not null default '{}'::jsonb check (
        jsonb_typeof(metadata) = 'object'
        and octet_length(metadata::text) <= 2000
        and metadata::text !~* (
            '(token|secret|password|authorization|cookie|signed[ _-]?url|'
            || 'coordinates?|geometry|latitude|longitude)'
        )
    ),
    completed_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (job_id, stage_name, stage_version)
);

create table app_private.processing_job_requeues (
    requeue_id bigint generated always as identity primary key,
    job_id text not null references app_private.processing_jobs (job_id),
    reviewer_id text not null check (
        reviewer_id ~ '^[a-z0-9][a-z0-9._:-]{2,127}$'
        and reviewer_id not in ('application', 'worker', 'service_role')
        and reviewer_id !~ '^(app|bot|worker)[._:-]'
    ),
    reason text not null check (
        length(reason) between 3 and 500
        and reason !~* (
            '(token|secret|password|authorization|cookie|'
            || 'signed[ _-]?url|coordinates?)'
        )
    ),
    previous_attempt_count integer not null check (previous_attempt_count >= 0),
    requeued_at timestamptz not null,
    created_at timestamptz not null default now()
);

alter table app_private.processing_stage_checkpoints enable row level security;
alter table app_private.processing_job_requeues enable row level security;

create function app_private.enforce_processing_job_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_requeue_exists boolean;
begin
    if old.state = new.state then
        return new;
    end if;

    if not (
        (old.state = 'discovered' and new.state in ('queued', 'deferred_quota'))
        or (old.state = 'queued' and new.state in ('preprocessing', 'deferred_quota', 'failed'))
        or (old.state = 'deferred_quota' and new.state = 'queued')
        or (old.state = 'preprocessing' and new.state in ('inferencing', 'queued', 'failed'))
        or (old.state = 'inferencing' and new.state in ('ready_for_review', 'queued', 'failed'))
        or (old.state = 'failed' and new.state = 'queued')
    ) then
        raise exception 'ILLEGAL_JOB_STATE_TRANSITION'
            using errcode = '23514';
    end if;

    if old.state = 'deferred_quota' and new.state = 'queued'
       and not exists (
           select 1 from app_private.dispatch_decisions as decision
           where decision.job_id = new.job_id
             and decision.decision = 'reserved'
       ) then
        raise exception 'QUOTA_READMISSION_REQUIRED'
            using errcode = '42501';
    end if;

    if old.state = 'failed' and new.state = 'queued' then
        select exists (
            select 1 from app_private.processing_job_requeues as requeue
            where requeue.job_id = new.job_id
              and requeue.requeued_at = new.updated_at
        ) into v_requeue_exists;
        if not v_requeue_exists then
            raise exception 'HUMAN_REQUEUE_REQUIRED'
                using errcode = '42501';
        end if;
    end if;

    if old.state in ('preprocessing', 'inferencing') and new.state = 'queued'
       and coalesce(new.error_code, '') not in (
           'NETWORK_TIMEOUT', 'TEMPORARY_PROVIDER_FAILURE',
           'GITHUB_TRANSIENT_FAILURE', 'TEMPORARY_STORAGE_FAILURE',
           'WORKER_INTERRUPTED', 'PROVIDER_STATUS_UNAVAILABLE'
       ) then
        raise exception 'RETRYABLE_ERROR_REQUIRED'
            using errcode = '23514';
    end if;

    if new.state = 'queued' then
        new.queued_at := coalesce(old.queued_at, new.queued_at, new.updated_at);
    elsif new.state = 'preprocessing' then
        new.preprocessing_at := coalesce(old.preprocessing_at, new.updated_at);
    elsif new.state = 'inferencing' then
        new.inferencing_at := coalesce(old.inferencing_at, new.updated_at);
    elsif new.state = 'ready_for_review' then
        new.ready_for_review_at := coalesce(
            old.ready_for_review_at,
            new.updated_at
        );
    elsif new.state = 'failed' then
        new.failed_at := coalesce(old.failed_at, new.updated_at);
    elsif new.state = 'deferred_quota' then
        new.deferred_quota_at := coalesce(
            old.deferred_quota_at,
            new.updated_at
        );
    end if;
    return new;
end;
$$;

create trigger processing_jobs_enforce_transition
before update of state on app_private.processing_jobs
for each row
execute function app_private.enforce_processing_job_transition();

create function app_private.claim_processing_job(
    p_worker_id text,
    p_lease_seconds integer,
    p_now timestamptz default now()
)
returns table (
    job_id text,
    state app_private.processing_job_state,
    attempt_count integer,
    max_attempts integer,
    claim_token uuid,
    lease_expires_at timestamptz,
    provider_job_id text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_worker_id !~ '^[a-z0-9][a-z0-9._:-]{2,127}$'
       or p_lease_seconds not between 60 and 3600 then
        raise exception 'INVALID_CLAIM_REQUEST' using errcode = '22023';
    end if;

    return query
    with eligible as (
        select candidate.job_id
        from app_private.processing_jobs as candidate
        where candidate.state = 'queued'
          and coalesce(candidate.next_attempt_at, '-infinity'::timestamptz)
              <= p_now
          and candidate.attempt_count < candidate.max_attempts
        order by
            case candidate.priority when 'P0' then 0 when 'P1' then 1 else 2 end,
            coalesce(candidate.queued_at, candidate.discovered_at),
            candidate.job_id
        for update skip locked
        limit 1
    )
    update app_private.processing_jobs as claimed
    set state = 'preprocessing',
        preprocessing_at = coalesce(claimed.preprocessing_at, p_now),
        attempt_count = claimed.attempt_count + 1,
        claimed_by = p_worker_id,
        claim_token = extensions.gen_random_uuid(),
        claimed_at = p_now,
        lease_expires_at = p_now + pg_catalog.make_interval(secs => p_lease_seconds),
        next_attempt_at = null,
        error_code = null,
        error_detail = null,
        failure = null,
        failed_at = null,
        updated_at = p_now
    from eligible
    where claimed.job_id = eligible.job_id
    returning claimed.job_id, claimed.state, claimed.attempt_count,
        claimed.max_attempts, claimed.claim_token, claimed.lease_expires_at,
        claimed.provider_job_id;
end;
$$;

create function app_private.renew_processing_job_lease(
    p_job_id text,
    p_claim_token uuid,
    p_lease_seconds integer,
    p_now timestamptz default now()
)
returns boolean
language sql
security definer
set search_path = ''
as $$
    update app_private.processing_jobs
    set lease_expires_at = p_now + pg_catalog.make_interval(secs => p_lease_seconds),
        updated_at = p_now
    where job_id = p_job_id
      and claim_token = p_claim_token
      and lease_expires_at > p_now
      and p_lease_seconds between 60 and 3600
      and state in ('preprocessing', 'inferencing')
    returning true;
$$;

create function app_private.complete_processing_stage(
    p_job_id text,
    p_claim_token uuid,
    p_stage app_private.processing_stage,
    p_stage_version text,
    p_content_checksum text,
    p_metadata jsonb default '{}'::jsonb,
    p_now timestamptz default now()
)
returns app_private.processing_stage_checkpoints
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_existing app_private.processing_stage_checkpoints;
    v_result app_private.processing_stage_checkpoints;
begin
    if p_stage_version !~ '^[0-9]+\.[0-9]+\.[0-9]+$'
       or p_content_checksum !~ '^[0-9a-f]{64}$'
       or jsonb_typeof(p_metadata) <> 'object' then
        raise exception 'INVALID_CHECKPOINT' using errcode = '22023';
    end if;
    if not exists (
        select 1 from app_private.processing_jobs as job
        where job.job_id = p_job_id
          and job.claim_token = p_claim_token
          and job.lease_expires_at > p_now
          and (
              (p_stage = 'preprocessing' and job.state = 'preprocessing')
              or (
                  p_stage in ('inferencing', 'asset_upload')
                  and job.state = 'inferencing'
              )
          )
        for update
    ) then
        raise exception 'STALE_JOB_CLAIM' using errcode = '40001';
    end if;
    insert into app_private.processing_stage_checkpoints (
        job_id, stage_name, stage_version, content_checksum, metadata,
        completed_at, created_at, updated_at
    ) values (
        p_job_id, p_stage, p_stage_version, p_content_checksum, p_metadata,
        p_now, p_now, p_now
    ) on conflict (job_id, stage_name, stage_version) do nothing
    returning * into v_result;
    if found then
        return v_result;
    end if;
    select checkpoint.* into v_existing
    from app_private.processing_stage_checkpoints as checkpoint
    where checkpoint.job_id = p_job_id
      and checkpoint.stage_name = p_stage
      and checkpoint.stage_version = p_stage_version;
    if v_existing.content_checksum <> p_content_checksum then
        raise exception 'CORRUPTED_OUTPUT' using errcode = '23514';
    end if;
    return v_existing;
end;
$$;

create function app_private.advance_processing_job(
    p_job_id text,
    p_claim_token uuid,
    p_target app_private.processing_job_state,
    p_now timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_updated integer;
begin
    if p_target not in ('inferencing', 'ready_for_review') then
        raise exception 'INVALID_ADVANCE_TARGET' using errcode = '22023';
    end if;
    update app_private.processing_jobs
    set state = p_target,
        claimed_by = case when p_target = 'ready_for_review' then null else claimed_by end,
        claim_token = case when p_target = 'ready_for_review' then null else claim_token end,
        claimed_at = case when p_target = 'ready_for_review' then null else claimed_at end,
        lease_expires_at = case when p_target = 'ready_for_review' then null else lease_expires_at end,
        updated_at = p_now
    where job_id = p_job_id
      and claim_token = p_claim_token
      and lease_expires_at > p_now
      and (
          (state = 'preprocessing' and p_target = 'inferencing')
          or (state = 'inferencing' and p_target = 'ready_for_review')
      );
    get diagnostics v_updated = row_count;
    return v_updated = 1;
end;
$$;

create function app_private.fail_processing_job(
    p_job_id text,
    p_claim_token uuid,
    p_error_code text,
    p_error_detail text,
    p_retryable boolean,
    p_retry_delay_seconds integer,
    p_now timestamptz default now()
)
returns app_private.processing_job_state
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_job app_private.processing_jobs;
    v_target app_private.processing_job_state;
begin
    select job.* into v_job
    from app_private.processing_jobs as job
    where job.job_id = p_job_id
      and job.claim_token = p_claim_token
      and job.lease_expires_at > p_now
      and job.state in ('preprocessing', 'inferencing')
    for update;
    if not found then
        raise exception 'STALE_JOB_CLAIM' using errcode = '40001';
    end if;
    if p_error_code !~ '^[A-Z][A-Z0-9_]{2,63}$'
       or length(p_error_detail) not between 1 and 500
       or p_error_detail ~* '(token|secret|password|authorization|cookie|signed[ _-]?url|coordinates?)'
       or p_retry_delay_seconds not between 1 and 3600 then
        raise exception 'INVALID_FAILURE' using errcode = '22023';
    end if;
    v_target := case
        when p_retryable and v_job.attempt_count < v_job.max_attempts
            then 'queued'::app_private.processing_job_state
        else 'failed'::app_private.processing_job_state
    end;
    update app_private.processing_jobs
    set state = v_target,
        next_attempt_at = case when v_target = 'queued'
            then p_now + pg_catalog.make_interval(secs => p_retry_delay_seconds)
            else null end,
        claimed_by = null,
        claim_token = null,
        claimed_at = null,
        lease_expires_at = null,
        error_code = p_error_code,
        error_detail = p_error_detail,
        failure = case when v_target = 'failed' then pg_catalog.jsonb_build_object(
            'code', p_error_code,
            'stage', v_job.state::text,
            'retryable', p_retryable,
            'detail', p_error_detail
        ) else null end,
        updated_at = p_now
    where job_id = p_job_id;
    return v_target;
end;
$$;

create function app_private.recover_expired_processing_job(
    p_job_id text,
    p_claim_token uuid,
    p_provider_status text,
    p_retry_delay_seconds integer,
    p_now timestamptz default now()
)
returns app_private.processing_job_state
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_job app_private.processing_jobs;
    v_target app_private.processing_job_state;
    v_code text;
begin
    select job.* into v_job
    from app_private.processing_jobs as job
    where job.job_id = p_job_id
      and job.claim_token = p_claim_token
      and job.lease_expires_at <= p_now
      and job.state in ('preprocessing', 'inferencing')
    for update;
    if not found then
        raise exception 'STALE_JOB_CLAIM' using errcode = '40001';
    end if;
    if p_provider_status not in (
        'not_submitted', 'queued', 'running', 'finished', 'error',
        'canceled', 'unavailable', 'ambiguous'
    ) or p_retry_delay_seconds not between 1 and 3600 then
        raise exception 'INVALID_RECOVERY' using errcode = '22023';
    end if;
    if v_job.provider_job_id is null and p_provider_status <> 'not_submitted' then
        raise exception 'PROVIDER_ID_STATUS_MISMATCH' using errcode = '23514';
    end if;
    if v_job.provider_job_id is not null and p_provider_status = 'not_submitted' then
        raise exception 'PROVIDER_ID_STATUS_MISMATCH' using errcode = '23514';
    end if;
    if p_provider_status in (
        'queued', 'running', 'finished', 'unavailable', 'ambiguous'
    ) then
        update app_private.processing_jobs
        set claimed_by = 'recovery:' || substr(p_claim_token::text, 1, 12),
            claim_token = extensions.gen_random_uuid(),
            claimed_at = p_now,
            lease_expires_at = p_now + interval '5 minutes',
            error_code = case when p_provider_status in ('unavailable', 'ambiguous')
                then 'PROVIDER_STATUS_UNAVAILABLE' else null end,
            error_detail = case when p_provider_status in ('unavailable', 'ambiguous')
                then 'PROVIDER_STATUS_UNAVAILABLE' else null end,
            updated_at = p_now
        where job_id = p_job_id;
        return v_job.state;
    end if;
    v_code := case p_provider_status
        when 'error' then 'TEMPORARY_PROVIDER_FAILURE'
        when 'canceled' then 'PROVIDER_JOB_CANCELLED'
        when 'unavailable' then 'PROVIDER_STATUS_UNAVAILABLE'
        when 'ambiguous' then 'PROVIDER_STATUS_UNAVAILABLE'
        else 'WORKER_INTERRUPTED'
    end;
    v_target := case
        when p_provider_status = 'canceled' or v_job.attempt_count >= v_job.max_attempts
            then 'failed'::app_private.processing_job_state
        else 'queued'::app_private.processing_job_state
    end;
    update app_private.processing_jobs
    set state = v_target,
        next_attempt_at = case when v_target = 'queued'
            then p_now + pg_catalog.make_interval(secs => p_retry_delay_seconds)
            else null end,
        claimed_by = null,
        claim_token = null,
        claimed_at = null,
        lease_expires_at = null,
        error_code = v_code,
        error_detail = v_code,
        failure = case when v_target = 'failed' then pg_catalog.jsonb_build_object(
            'code', v_code, 'stage', v_job.state::text,
            'retryable', p_provider_status <> 'canceled', 'detail', v_code
        ) else null end,
        updated_at = p_now
    where job_id = p_job_id;
    return v_target;
end;
$$;

create function app_private.human_requeue_processing_job(
    p_job_id text,
    p_reviewer_id text,
    p_reason text,
    p_now timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_attempt_count integer;
begin
    if p_reviewer_id !~ '^[a-z0-9][a-z0-9._:-]{2,127}$'
       or p_reviewer_id in ('application', 'worker', 'service_role')
       or p_reviewer_id ~ '^(app|bot|worker)[._:-]'
       or p_reviewer_id <> session_user
       or length(p_reason) not between 3 and 500
       or p_reason ~* '(token|secret|password|authorization|cookie|signed[ _-]?url|coordinates?)' then
        raise exception 'INVALID_HUMAN_REQUEUE' using errcode = '22023';
    end if;
    select attempt_count into v_attempt_count
    from app_private.processing_jobs
    where job_id = p_job_id and state = 'failed'
    for update;
    if not found then
        raise exception 'FAILED_JOB_NOT_FOUND' using errcode = 'P0002';
    end if;
    if not exists (
        select 1 from app_private.provider_job_runs as run
        where run.job_id = p_job_id
          and run.state in ('reserved', 'submitted', 'queued', 'running', 'finished')
    ) then
        raise exception 'QUOTA_READMISSION_REQUIRED' using errcode = '42501';
    end if;
    insert into app_private.processing_job_requeues (
        job_id, reviewer_id, reason, previous_attempt_count, requeued_at
    ) values (
        p_job_id, p_reviewer_id, p_reason, v_attempt_count, p_now
    );
    update app_private.processing_jobs
    set state = 'queued',
        attempt_count = 0,
        next_attempt_at = p_now,
        claimed_by = null,
        claim_token = null,
        claimed_at = null,
        lease_expires_at = null,
        error_code = null,
        error_detail = null,
        failure = null,
        failed_at = null,
        updated_at = p_now
    where job_id = p_job_id;
    return true;
end;
$$;

create function app_private.sync_processing_job_provider_id()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    update app_private.processing_jobs
    set provider_job_id = new.provider_job_id,
        updated_at = greatest(updated_at, new.updated_at)
    where job_id = new.job_id;
    return new;
end;
$$;

create trigger provider_job_runs_sync_processing_job
after insert or update of provider_job_id on app_private.provider_job_runs
for each row
execute function app_private.sync_processing_job_provider_id();

create function app_private.reject_provider_job_id_divergence()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if new.provider_job_id is distinct from (
        select run.provider_job_id
        from app_private.provider_job_runs as run
        where run.job_id = new.job_id
    ) then
        raise exception 'PROVIDER_JOB_ID_DIVERGENCE' using errcode = '23514';
    end if;
    return new;
end;
$$;

create trigger processing_jobs_reject_provider_job_id_divergence
before update of provider_job_id on app_private.processing_jobs
for each row
execute function app_private.reject_provider_job_id_divergence();

revoke all on table app_private.processing_stage_checkpoints
from public, anon, authenticated;
revoke all on table app_private.processing_job_requeues
from public, anon, authenticated;
revoke execute on all functions in schema app_private
from public, anon, authenticated;

do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'part9_reviewer') then
        create role part9_reviewer nologin;
    end if;
end;
$$;

grant usage on schema app_private to part9_reviewer;
grant execute on function app_private.human_requeue_processing_job(
    text, text, text, timestamptz
) to part9_reviewer;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        grant usage on schema app_private to service_role;
        grant execute on function app_private.claim_processing_job(
            text, integer, timestamptz
        ) to service_role;
        grant execute on function app_private.renew_processing_job_lease(
            text, uuid, integer, timestamptz
        ) to service_role;
        grant execute on function app_private.complete_processing_stage(
            text, uuid, app_private.processing_stage, text, text, jsonb,
            timestamptz
        ) to service_role;
        grant execute on function app_private.advance_processing_job(
            text, uuid, app_private.processing_job_state, timestamptz
        ) to service_role;
        grant execute on function app_private.fail_processing_job(
            text, uuid, text, text, boolean, integer, timestamptz
        ) to service_role;
        grant execute on function app_private.recover_expired_processing_job(
            text, uuid, text, integer, timestamptz
        ) to service_role;
    end if;
end;
$$;

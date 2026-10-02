create table app_private.provider_usage_snapshots (
    snapshot_id bigint generated always as identity primary key,
    account_scope text not null check (
        account_scope = 'cdse-openeo-service-account'
    ),
    accounting_month text not null check (
        accounting_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    ),
    allowance_credits numeric not null check (allowance_credits > 0),
    used_credits numeric not null check (used_credits >= 0),
    fetched_at timestamptz not null,
    provenance text not null check (provenance = 'provider-reported'),
    created_at timestamptz not null default now(),
    constraint provider_usage_within_allowance_check check (
        used_credits <= allowance_credits
    )
);

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
            'PROVIDER_JOB_FAILED', 'PROVIDER_JOB_CANCELLED'
        )
    )
    or (
        state <> 'failed'
        and failed_at is null
        and failure is null
    )
);

create table app_private.reviewer_releases (
    job_id text primary key references app_private.processing_jobs (job_id),
    reviewer_id text not null check (
        reviewer_id ~ '^[a-z0-9][a-z0-9._:-]{2,127}$'
        and reviewer_id <> 'application'
    ),
    reason text not null check (length(reason) between 1 and 500),
    policy_version text not null,
    released_at timestamptz not null,
    condition_code text not null check (
        condition_code = 'USAGE_UNAVAILABLE'
    ),
    created_at timestamptz not null default now()
);

-- Membership is granted to a separately authenticated human login during
-- deployment. The worker login must never be a member of this role.
do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'part7_reviewer') then
        create role part7_reviewer nologin;
    end if;
end;
$$;

grant usage on schema app_private to part7_reviewer;
grant insert on app_private.reviewer_releases to part7_reviewer;

create policy reviewer_release_insert
on app_private.reviewer_releases
for insert to part7_reviewer
with check (reviewer_id = session_user);

create function app_private.guard_reviewer_release()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if tg_op <> 'INSERT' then
        raise exception 'reviewer releases are append-only'
            using errcode = '23514';
    end if;
    if current_user <> 'part7_reviewer' or new.reviewer_id <> session_user then
        raise exception 'reviewer release requires a separate reviewer login'
            using errcode = '42501';
    end if;
    return new;
end;
$$;

create trigger reviewer_release_guard
before insert or update or delete on app_private.reviewer_releases
for each row execute function app_private.guard_reviewer_release();

create table app_private.provider_job_runs (
    job_id text primary key references app_private.processing_jobs (job_id),
    provider_job_id text unique,
    aoi_id text not null,
    policy_version text not null,
    graph_version text not null,
    priority app_private.aoi_priority not null,
    allocation_bucket text not null check (
        allocation_bucket in ('scheduled', 'retry', 'priority')
    ),
    accounting_month text not null check (
        accounting_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    ),
    state text not null check (
        state in (
            'reserved', 'submitting', 'submitted', 'queued', 'running',
            'finished', 'error', 'canceled', 'ambiguous', 'deferred_quota'
        )
    ),
    estimate_credits numeric not null check (estimate_credits > 0),
    estimate_provenance text not null check (
        estimate_provenance in ('estimated', 'provider-reported')
    ),
    actual_credits numeric check (actual_credits >= 0),
    actual_provenance text not null default 'unavailable' check (
        actual_provenance in ('provider-reported', 'unavailable')
    ),
    usage_snapshot_id bigint references app_private.provider_usage_snapshots (
        snapshot_id
    ),
    decision_reason text not null,
    decision_at timestamptz not null,
    submitted_at timestamptz,
    started_at timestamptz,
    completed_at timestamptz,
    output_bytes bigint check (output_bytes >= 0),
    failure_code text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    foreign key (aoi_id, policy_version)
    references app_private.aois (aoi_id, policy_version),
    constraint provider_job_actual_provenance_check check (
        (actual_credits is null) = (actual_provenance = 'unavailable')
    ),
    constraint provider_job_completion_check check (
        state <> 'finished' or completed_at is not null
    ),
    constraint provider_job_submission_check check (
        provider_job_id is null or submitted_at is not null
    )
);

create table app_private.dispatch_decisions (
    decision_id bigint generated always as identity primary key,
    job_id text not null references app_private.provider_job_runs (job_id),
    policy_version text not null,
    decision text not null check (
        decision in ('reserved', 'deferred_quota')
    ),
    reason_code text not null,
    usage_snapshot_id bigint references app_private.provider_usage_snapshots (
        snapshot_id
    ),
    reviewer_id text,
    decided_at timestamptz not null,
    created_at timestamptz not null default now()
);

create table app_private.credit_ledger (
    ledger_entry_id text primary key,
    event_key text not null unique,
    job_id text not null references app_private.provider_job_runs (job_id),
    provider_job_id text,
    aoi_id text not null,
    policy_version text not null,
    priority app_private.aoi_priority not null,
    accounting_month text not null,
    allocation_bucket text not null check (
        allocation_bucket in ('scheduled', 'retry', 'priority')
    ),
    entry_kind text not null check (
        entry_kind in ('estimate', 'actual', 'adjustment', 'release')
    ),
    credits numeric not null,
    provenance text not null check (
        provenance in (
            'estimated', 'provider-reported', 'derived', 'unavailable'
        )
    ),
    status text not null check (
        status in ('reserved', 'recorded', 'released')
    ),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint credit_ledger_positive_fact_check check (
        entry_kind = 'adjustment' or credits >= 0
    ),
    constraint credit_ledger_event_identity_check check (
        ledger_entry_id = event_key
    )
);

alter table app_private.coverage_gaps
add column job_id text references app_private.processing_jobs (job_id);

create unique index coverage_gaps_one_part7_gap_per_job
on app_private.coverage_gaps (job_id)
where job_id is not null;

create index provider_job_runs_active_reservations
on app_private.provider_job_runs (accounting_month, allocation_bucket)
where state in (
    'reserved', 'submitting', 'submitted', 'queued', 'running', 'ambiguous'
);

create index credit_ledger_job_events
on app_private.credit_ledger (job_id, created_at);

alter table app_private.provider_usage_snapshots enable row level security;
alter table app_private.reviewer_releases enable row level security;
alter table app_private.provider_job_runs enable row level security;
alter table app_private.dispatch_decisions enable row level security;
alter table app_private.credit_ledger enable row level security;

create function app_private.reject_credit_ledger_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    raise exception 'credit ledger entries are append-only'
        using errcode = '23514';
end;
$$;

create trigger credit_ledger_append_only
before update or delete on app_private.credit_ledger
for each row
execute function app_private.reject_credit_ledger_change();

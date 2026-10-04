-- Claim exactly the immutable job selected by the short-lived workflow run.
-- The original queue-wide function remains the dispatcher/worker primitive.
create function app_private.claim_processing_job_by_id(
    p_job_id text,
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
    if p_job_id !~ '^job:[0-9a-f]{32}$'
       or p_worker_id !~ '^[a-z0-9][a-z0-9._:-]{2,127}$'
       or p_lease_seconds not between 60 and 3600 then
        raise exception 'INVALID_CLAIM_REQUEST' using errcode = '22023';
    end if;

    return query
    with eligible as (
        select candidate.job_id
        from app_private.processing_jobs as candidate
        where candidate.job_id = p_job_id
          and candidate.state = 'queued'
          and coalesce(candidate.next_attempt_at, '-infinity'::timestamptz)
              <= p_now
          and candidate.attempt_count < candidate.max_attempts
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

revoke execute on function app_private.claim_processing_job_by_id(
    text, text, integer, timestamptz
) from public, anon, authenticated;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        grant execute on function app_private.claim_processing_job_by_id(
            text, text, integer, timestamptz
        ) to service_role;
    end if;
end;
$$;

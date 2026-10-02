create extension if not exists pgcrypto with schema extensions;

create type app_private.scene_polarization_disposition as enum (
    'dual_band',
    'missing_vh',
    'invalid_polarization'
);

alter table app_private.scenes
add column collection text not null default 'legacy',
add column acquisition_start timestamptz,
add column acquisition_end timestamptz,
add column platform text,
add column orbit_direction text,
add column relative_orbit integer,
add column product_type text,
add column polarizations text[],
add column footprint extensions.geometry (geometry, 4326),
add column published_at timestamptz,
add column asset_references jsonb,
add column raw_metadata_checksum text,
add column polarization_disposition
app_private.scene_polarization_disposition;

alter table app_private.scenes
drop constraint scenes_provider_identity_key;

alter table app_private.scenes
add constraint scenes_catalogue_identity_key unique (
    source_provider,
    collection,
    provider_scene_id
),
add constraint scenes_part8_required_metadata_check check (
    collection = 'legacy'
    or (
        acquisition_start is not null
        and acquisition_end is not null
        and platform is not null
        and orbit_direction is not null
        and relative_orbit is not null
        and product_type is not null
        and polarizations is not null
        and footprint is not null
        and asset_references is not null
        and raw_metadata_checksum is not null
        and polarization_disposition is not null
    )
),
add constraint scenes_acquisition_order_check check (
    acquisition_end is null or acquisition_end >= acquisition_start
),
add constraint scenes_platform_check check (
    platform is null or platform in ('sentinel-1a', 'sentinel-1b', 'sentinel-1c')
),
add constraint scenes_orbit_direction_check check (
    orbit_direction is null or orbit_direction in ('ascending', 'descending')
),
add constraint scenes_relative_orbit_check check (
    relative_orbit is null or relative_orbit > 0
),
add constraint scenes_product_type_check check (
    product_type is null or product_type = 'IW_GRDH_1S'
),
add constraint scenes_polarizations_check check (
    polarizations is null
    or (
        cardinality(polarizations) > 0
        and polarizations <@ array['HH', 'HV', 'VH', 'VV']::text[]
    )
),
add constraint scenes_footprint_nonempty_check check (
    footprint is null or not extensions.st_isempty(footprint)
),
add constraint scenes_footprint_valid_check check (
    footprint is null or extensions.st_isvalid(footprint)
),
add constraint scenes_footprint_type_check check (
    footprint is null
    or extensions.geometrytype(footprint) in ('POLYGON', 'MULTIPOLYGON')
),
add constraint scenes_footprint_bounds_check check (
    footprint is null
    or (
        extensions.st_xmin(extensions.box3d(footprint)) >= -180
        and extensions.st_xmax(extensions.box3d(footprint)) <= 180
        and extensions.st_ymin(extensions.box3d(footprint)) >= -90
        and extensions.st_ymax(extensions.box3d(footprint)) <= 90
    )
),
add constraint scenes_assets_shape_check check (
    asset_references is null or jsonb_typeof(asset_references) = 'array'
),
add constraint scenes_checksum_shape_check check (
    raw_metadata_checksum is null
    or raw_metadata_checksum ~ '^[0-9a-f]{64}$'
),
add constraint scenes_polarization_disposition_check check (
    polarization_disposition is null
    or (
        polarization_disposition = 'dual_band'
        and polarizations @> array['VV', 'VH']::text[]
    )
    or (
        polarization_disposition = 'missing_vh'
        and polarizations @> array['VV']::text[]
        and not polarizations @> array['VH']::text[]
    )
    or (
        polarization_disposition = 'invalid_polarization'
        and not polarizations @> array['VV']::text[]
    )
);

alter table app_private.scenes
alter column collection drop default;

create index scenes_footprint_gist
on app_private.scenes using gist (footprint);

create index scenes_catalogue_lookup
on app_private.scenes (source_provider, collection, provider_scene_id);

create table app_private.discovery_poll_runs (
    poll_run_id bigint generated always as identity primary key,
    poll_started_at timestamptz not null,
    window_from timestamptz not null,
    window_to timestamptz not null,
    status text not null check (status in ('succeeded', 'failed')),
    error_code text check (
        error_code is null
        or error_code in (
            'INVALID_CONFIG', 'INVALID_PROVIDER_RESPONSE', 'RATE_LIMITED',
            'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE',
            'PERSISTENCE_FAILED', 'UNAUTHORIZED', 'UNSAFE_PAGINATION',
            'LIMIT_EXCEEDED'
        )
    ),
    provider_request_id text,
    pages_fetched integer not null default 0 check (pages_fetched >= 0),
    raw_item_count integer not null default 0 check (raw_item_count >= 0),
    unique_item_count integer not null default 0 check (unique_item_count >= 0),
    normalized_item_count integer not null default 0 check (
        normalized_item_count >= 0
    ),
    rejected_item_count integer not null default 0 check (
        rejected_item_count >= 0
    ),
    missing_vh_count integer not null default 0 check (missing_vh_count >= 0),
    created_scene_count integer not null default 0 check (
        created_scene_count >= 0
    ),
    updated_scene_count integer not null default 0 check (
        updated_scene_count >= 0
    ),
    created_job_count integer not null default 0 check (created_job_count >= 0),
    existing_job_count integer not null default 0 check (
        existing_job_count >= 0
    ),
    duration_ms integer not null check (duration_ms >= 0),
    warnings jsonb not null default '[]'::jsonb check (
        jsonb_typeof(warnings) = 'array'
    ),
    completed_at timestamptz not null default now(),
    constraint discovery_poll_window_check check (
        window_from <= poll_started_at
        and poll_started_at = window_to
    ),
    constraint discovery_poll_status_check check (
        (status = 'succeeded' and error_code is null)
        or (status = 'failed' and error_code is not null)
    )
);

alter table app_private.discovery_poll_runs enable row level security;

create function public.part8_enabled_aoi_queries(p_at timestamptz)
returns table (
    aoi_id text,
    policy_version text,
    geometry jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
    select distinct on (a.aoi_id)
        a.aoi_id,
        a.policy_version,
        extensions.st_asgeojson(a.area_geometry)::jsonb as geometry
    from app_private.aois as a
    where a.enabled
      and a.valid_from <= p_at
      and (a.valid_to is null or p_at < a.valid_to)
    order by a.aoi_id, a.valid_from desc, a.policy_version desc;
$$;

create function public.record_part8_discovery_poll(
    p_status text,
    p_poll_started_at timestamptz,
    p_window_from timestamptz,
    p_window_to timestamptz,
    p_duration_ms integer,
    p_error_code text default null,
    p_provider_request_id text default null,
    p_pages_fetched integer default 0,
    p_raw_item_count integer default 0,
    p_unique_item_count integer default 0,
    p_normalized_item_count integer default 0,
    p_rejected_item_count integer default 0,
    p_missing_vh_count integer default 0,
    p_warnings jsonb default '[]'::jsonb,
    p_scenes jsonb default '[]'::jsonb,
    p_preprocessing_version text default '1.0.0',
    p_model_version text default '1.0.0'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_item jsonb;
    v_scene_id text;
    v_scene_inserted boolean;
    v_footprint extensions.geometry;
    v_aoi record;
    v_job_id text;
    v_row_count integer;
    v_poll_run_id bigint;
    v_created_scenes integer := 0;
    v_updated_scenes integer := 0;
    v_created_jobs integer := 0;
    v_existing_jobs integer := 0;
begin
    if p_status not in ('succeeded', 'failed')
       or p_window_from > p_poll_started_at
       or p_poll_started_at <> p_window_to
       or p_duration_ms < 0
       or jsonb_typeof(p_warnings) <> 'array'
       or jsonb_typeof(p_scenes) <> 'array'
       or p_preprocessing_version !~ '^[0-9]+\.[0-9]+\.[0-9]+$'
       or p_model_version !~ '^[0-9]+\.[0-9]+\.[0-9]+$' then
        raise exception 'invalid Part 8 persistence request'
            using errcode = '22023';
    end if;

    if p_status = 'failed' then
        insert into app_private.discovery_poll_runs (
            poll_started_at, window_from, window_to, status, error_code,
            duration_ms
        ) values (
            p_poll_started_at, p_window_from, p_window_to, p_status,
            p_error_code, p_duration_ms
        ) returning poll_run_id into v_poll_run_id;
        return jsonb_build_object('pollRunId', v_poll_run_id);
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('app_private.part8.discovery')
    );

    for v_item in select value from jsonb_array_elements(p_scenes)
    loop
        if not v_item ?& array[
            'sceneId', 'sourceProvider', 'collection', 'providerItemId',
            'acquisitionStart', 'acquisitionEnd', 'platform',
            'orbitDirection', 'relativeOrbit', 'productType', 'polarizations',
            'footprint', 'firstDiscoveredAt', 'lastDiscoveredAt', 'assets',
            'rawMetadataChecksum', 'polarizationDisposition'
        ] then
            raise exception 'invalid normalized scene'
                using errcode = '22023';
        end if;
        v_footprint := extensions.st_setsrid(
            extensions.st_geomfromgeojson(v_item -> 'footprint'),
            4326
        );
        if extensions.st_isempty(v_footprint)
           or not extensions.st_isvalid(v_footprint)
           or extensions.geometrytype(v_footprint) not in (
               'POLYGON', 'MULTIPOLYGON'
           ) then
            raise exception 'invalid scene footprint'
                using errcode = '22023';
        end if;

        insert into app_private.scenes (
            scene_id, source_provider, collection, provider_scene_id,
            acquisition_start, acquisition_end, platform, orbit_direction,
            relative_orbit, product_type, polarizations, footprint,
            published_at, first_discovered_at, last_discovered_at,
            asset_references, raw_metadata_checksum,
            polarization_disposition
        ) values (
            v_item ->> 'sceneId', v_item ->> 'sourceProvider',
            v_item ->> 'collection', v_item ->> 'providerItemId',
            (v_item ->> 'acquisitionStart')::timestamptz,
            (v_item ->> 'acquisitionEnd')::timestamptz,
            v_item ->> 'platform', v_item ->> 'orbitDirection',
            (v_item ->> 'relativeOrbit')::integer,
            v_item ->> 'productType',
            array(select jsonb_array_elements_text(v_item -> 'polarizations')),
            v_footprint,
            nullif(v_item ->> 'publishedAt', '')::timestamptz,
            (v_item ->> 'firstDiscoveredAt')::timestamptz,
            (v_item ->> 'lastDiscoveredAt')::timestamptz,
            v_item -> 'assets', v_item ->> 'rawMetadataChecksum',
            (v_item ->> 'polarizationDisposition')
                ::app_private.scene_polarization_disposition
        )
        on conflict (source_provider, collection, provider_scene_id)
        do update set
            acquisition_start = excluded.acquisition_start,
            acquisition_end = excluded.acquisition_end,
            platform = excluded.platform,
            orbit_direction = excluded.orbit_direction,
            relative_orbit = excluded.relative_orbit,
            product_type = excluded.product_type,
            polarizations = excluded.polarizations,
            footprint = excluded.footprint,
            published_at = coalesce(excluded.published_at, scenes.published_at),
            first_discovered_at = least(
                scenes.first_discovered_at,
                excluded.first_discovered_at
            ),
            last_discovered_at = greatest(
                scenes.last_discovered_at,
                excluded.last_discovered_at
            ),
            asset_references = case
                when jsonb_array_length(excluded.asset_references)
                    >= jsonb_array_length(scenes.asset_references)
                    then excluded.asset_references
                else scenes.asset_references
            end,
            raw_metadata_checksum = case
                when jsonb_array_length(excluded.asset_references)
                    >= jsonb_array_length(scenes.asset_references)
                    then excluded.raw_metadata_checksum
                else scenes.raw_metadata_checksum
            end,
            polarization_disposition = excluded.polarization_disposition
        returning scene_id, (xmax = 0) into v_scene_id, v_scene_inserted;

        if v_scene_inserted then
            v_created_scenes := v_created_scenes + 1;
        else
            v_updated_scenes := v_updated_scenes + 1;
        end if;

        if v_item ->> 'polarizationDisposition' = 'dual_band' then
            for v_aoi in
                select distinct on (a.aoi_id) a.aoi_id
                from app_private.aois as a
                where a.enabled
                  and a.valid_from <= p_poll_started_at
                  and (a.valid_to is null or p_poll_started_at < a.valid_to)
                  and extensions.st_intersects(a.area_geometry, v_footprint)
                  and extensions.st_area(
                      extensions.st_intersection(a.area_geometry, v_footprint)
                  ) > 0
                order by a.aoi_id, a.valid_from desc, a.policy_version desc
            loop
                v_job_id := 'job:' || substr(
                    pg_catalog.encode(
                        extensions.digest(
                            pg_catalog.convert_to(
                                v_scene_id || chr(31) || v_aoi.aoi_id
                                || chr(31) || p_preprocessing_version
                                || chr(31) || p_model_version,
                                'UTF8'
                            ),
                            'sha256'
                        ),
                        'hex'
                    ),
                    1,
                    32
                );
                insert into app_private.processing_jobs (
                    job_id, scene_id, aoi_id, preprocessing_version,
                    model_version, state, discovered_at
                ) values (
                    v_job_id, v_scene_id, v_aoi.aoi_id,
                    p_preprocessing_version, p_model_version,
                    'discovered', p_poll_started_at
                ) on conflict (
                    scene_id, aoi_id, preprocessing_version, model_version
                ) do nothing;
                get diagnostics v_row_count = row_count;
                if v_row_count = 1 then
                    v_created_jobs := v_created_jobs + 1;
                else
                    v_existing_jobs := v_existing_jobs + 1;
                end if;
            end loop;
        end if;
    end loop;

    insert into app_private.discovery_poll_runs (
        poll_started_at, window_from, window_to, status,
        provider_request_id, pages_fetched, raw_item_count,
        unique_item_count, normalized_item_count, rejected_item_count,
        missing_vh_count, created_scene_count, updated_scene_count,
        created_job_count, existing_job_count, duration_ms, warnings
    ) values (
        p_poll_started_at, p_window_from, p_window_to, p_status,
        p_provider_request_id, p_pages_fetched, p_raw_item_count,
        p_unique_item_count, p_normalized_item_count, p_rejected_item_count,
        p_missing_vh_count, v_created_scenes, v_updated_scenes,
        v_created_jobs, v_existing_jobs, p_duration_ms, p_warnings
    ) returning poll_run_id into v_poll_run_id;

    return jsonb_build_object(
        'pollRunId', v_poll_run_id,
        'createdSceneCount', v_created_scenes,
        'updatedSceneCount', v_updated_scenes,
        'createdJobCount', v_created_jobs,
        'existingJobCount', v_existing_jobs
    );
end;
$$;

revoke all on function public.part8_enabled_aoi_queries(timestamptz)
from public, anon, authenticated;
revoke all on function public.record_part8_discovery_poll(
    text, timestamptz, timestamptz, timestamptz, integer, text, text,
    integer, integer, integer, integer, integer, integer, jsonb, jsonb,
    text, text
) from public, anon, authenticated;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        grant execute on function public.part8_enabled_aoi_queries(timestamptz)
        to service_role;
        grant execute on function public.record_part8_discovery_poll(
            text, timestamptz, timestamptz, timestamptz, integer, text, text,
            integer, integer, integer, integer, integer, integer, jsonb,
            jsonb, text, text
        ) to service_role;
    end if;
end;
$$;

-- Hosted Supabase provides Cron, pg_net, and Vault. Local database tests skip
-- schedule installation when those extensions are unavailable.
do $part8_cron$
declare
    v_command text;
begin
    if exists (
        select 1 from pg_available_extensions where name = 'pg_cron'
    ) and exists (
        select 1 from pg_available_extensions where name = 'pg_net'
    ) and exists (
        select 1 from pg_available_extensions where name = 'supabase_vault'
    ) then
        execute 'create extension if not exists pg_cron with schema pg_catalog';
        execute 'create extension if not exists pg_net with schema extensions';
        execute 'create extension if not exists supabase_vault with schema vault';
        execute 'select cron.unschedule($1)'
        using 'part8-stac-discovery';
        v_command := $scheduled$
            select net.http_post(
                url := (
                    select decrypted_secret
                    from vault.decrypted_secrets
                    where name = 'project_url'
                ) || '/functions/v1/part8-discovery',
                headers := jsonb_build_object(
                    'Content-Type', 'application/json',
                    'apikey', (
                        select decrypted_secret
                        from vault.decrypted_secrets
                        where name = 'publishable_key'
                    ),
                    'Authorization', 'Bearer ' || (
                        select decrypted_secret
                        from vault.decrypted_secrets
                        where name = 'publishable_key'
                    ),
                    'x-discovery-secret', (
                        select decrypted_secret
                        from vault.decrypted_secrets
                        where name = 'part8_cron_secret'
                    )
                ),
                body := '{}'::jsonb,
                timeout_milliseconds := 60000
            ) as request_id;
        $scheduled$;
        execute 'select cron.schedule($1, $2, $3)'
        using 'part8-stac-discovery', '*/15 * * * *', v_command;
    end if;
end;
$part8_cron$;

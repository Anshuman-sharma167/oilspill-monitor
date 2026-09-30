create extension if not exists postgis with schema extensions;

create type app_private.aoi_priority as enum ('P0', 'P1', 'P2');
create type app_private.aoi_cost_estimate_status as enum (
    'estimated',
    'pending_provider_run'
);
create type app_private.coverage_gap_status as enum (
    'disabled',
    'deferred',
    'failed',
    'unobserved'
);

create table app_private.aois (
    aoi_id text not null,
    policy_version text not null,
    aoi_name text not null,
    area_geometry extensions.geometry (geometry, 4326) not null,
    enabled boolean not null default false,
    priority app_private.aoi_priority not null,
    valid_from timestamptz not null,
    valid_to timestamptz,
    dry_run_month date not null,
    estimated_scene_count integer not null check (estimated_scene_count >= 0),
    approximate_openeo_credits numeric check (approximate_openeo_credits >= 0),
    cost_estimate_status app_private.aoi_cost_estimate_status not null,
    cost_estimate_method text not null,
    cost_estimated_at timestamptz not null,
    water_mask_source text not null,
    coverage_status text not null check (
        coverage_status in ('covered', 'disabled', 'deferred', 'failed', 'unobserved')
    ),
    created_at timestamptz not null default now(),
    primary key (aoi_id, policy_version),
    constraint aois_valid_interval_check check (
        valid_to is null or valid_to > valid_from
    ),
    constraint aois_nonempty_check check (
        not extensions.st_isempty(area_geometry)
    ),
    constraint aois_valid_geometry_check check (
        extensions.st_isvalid(area_geometry)
    ),
    constraint aois_polygon_geometry_check check (
        extensions.geometrytype(area_geometry) in ('POLYGON', 'MULTIPOLYGON')
    ),
    constraint aois_winding_check check (
        extensions.st_ispolygonccw(area_geometry)
    ),
    constraint aois_longitude_check check (
        extensions.st_xmin(extensions.box3d(area_geometry)) >= -180
        and extensions.st_xmax(extensions.box3d(area_geometry)) <= 180
    ),
    constraint aois_latitude_check check (
        extensions.st_ymin(extensions.box3d(area_geometry)) >= -90
        and extensions.st_ymax(extensions.box3d(area_geometry)) <= 90
    ),
    constraint aois_enablement_cost_check check (
        not enabled
        or (
            cost_estimate_status = 'estimated'
            and approximate_openeo_credits is not null
        )
    )
);

create table app_private.monthly_credit_policies (
    policy_version text primary key,
    scheduled_percent integer not null default 60,
    retry_reprocessing_percent integer not null default 20,
    priority_emergency_percent integer not null default 20,
    p2_defer_at_total_percent integer not null default 80,
    constraint monthly_credit_allocation_check check (
        scheduled_percent = 60
        and retry_reprocessing_percent = 20
        and priority_emergency_percent = 20
        and scheduled_percent
        + retry_reprocessing_percent
        + priority_emergency_percent = 100
    ),
    constraint monthly_credit_p2_threshold_check check (
        p2_defer_at_total_percent = 80
    )
);

create table app_private.coverage_gaps (
    coverage_gap_id bigint generated always as identity primary key,
    aoi_id text not null,
    policy_version text not null,
    status app_private.coverage_gap_status not null,
    starts_at timestamptz not null,
    ends_at timestamptz,
    detail text not null,
    foreign key (aoi_id, policy_version)
    references app_private.aois (aoi_id, policy_version),
    constraint coverage_gap_interval_check check (
        ends_at is null or ends_at > starts_at
    )
);

alter table app_private.aois enable row level security;
alter table app_private.monthly_credit_policies enable row level security;
alter table app_private.coverage_gaps enable row level security;

insert into app_private.monthly_credit_policies (policy_version)
values ('1.0.0');

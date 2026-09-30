import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  coverageGapRows,
  type CoverageGap,
} from "../../apps/dashboard/src/index.js";
import {
  enabledCatalogueQueries,
  monthlyCreditPolicy,
  quotaDecision,
  type VersionedAoiFeature,
} from "../../packages/geo/src/index.js";
import {
  ContractValidationError,
  validateContract,
} from "../../packages/schemas/src/index.js";

interface AoiDataset {
  type: "FeatureCollection";
  quota_policy: {
    policy_version: string;
    scheduled_percent: number;
    retry_reprocessing_percent: number;
    priority_emergency_percent: number;
    p2_defer_at_total_percent: number;
  };
  features: Array<
    VersionedAoiFeature & {
      id: string;
      properties: VersionedAoiFeature["properties"] & Record<string, unknown>;
      geometry: { type: string; coordinates: number[][][] };
    }
  >;
}

const dataset = JSON.parse(
  readFileSync("data/aois.geojson", "utf8"),
) as AoiDataset;
const pilot = dataset.features[0];

test("AOI dataset contains the water-clipped versioned pilot", () => {
  assert.equal(dataset.type, "FeatureCollection");
  assert.ok(pilot);
  assert.equal(pilot.id, "aoi:western-coast-shadow-pilot");
  assert.equal(pilot.properties.priority, "P1");
  assert.equal(pilot.properties.enabled, false);
  assert.equal(pilot.properties.cost_estimate_status, "pending_provider_run");
  assert.equal(pilot.properties.estimated_scene_count, 13);
  assert.equal(pilot.properties.coverage_status, "disabled");
  assert.doesNotThrow(() =>
    validateContract("AOI", {
      ...pilot.properties,
      geometry: pilot.geometry,
    }),
  );

  const ring = pilot.geometry.coordinates[0];
  assert.ok(ring);
  const longitudes = ring.map((position) => {
    assert.ok(position[0] !== undefined);
    return position[0];
  });
  const latitudes = ring.map((position) => {
    assert.ok(position[1] !== undefined);
    return position[1];
  });
  assert.equal(Math.min(...longitudes), 69);
  assert.equal(Math.max(...longitudes), 73);
  assert.equal(Math.min(...latitudes), 18);
  assert.equal(Math.max(...latitudes), 21);
  assert.ok(ring.length > 5, "water clip must not remain the four-corner box");
});

test("local geometry checks reject winding, self-intersections, bounds, and empties", () => {
  assert.ok(pilot);
  const base = { ...pilot.properties, geometry: pilot.geometry };
  const cases = [
    {
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 0],
            [0, 0],
          ],
        ],
      },
      message: /winding/u,
    },
    {
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [3, 0],
            [0, 2],
            [2, 2],
            [0, 0],
          ],
        ],
      },
      message: /self-intersect/u,
    },
    {
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [181, 0],
            [181, 1],
            [179, 0],
            [181, 0],
          ],
        ],
      },
      message: /allowed shape/u,
    },
    {
      geometry: { type: "Polygon", coordinates: [] },
      message: /allowed shape/u,
    },
  ];

  for (const fixture of cases) {
    assert.throws(
      () => validateContract("AOI", { ...base, geometry: fixture.geometry }),
      (error: unknown) =>
        error instanceof ContractValidationError &&
        fixture.message.test(error.message),
    );
  }
});

test("an AOI cannot be enabled before a provider cost estimate is recorded", () => {
  assert.ok(pilot);
  assert.throws(
    () =>
      validateContract("AOI", {
        ...pilot.properties,
        enabled: true,
        geometry: pilot.geometry,
      }),
    /provider cost estimate/u,
  );
});

test("quota policy reserves 60/20/20 and defers new P2 work at 80 percent", () => {
  assert.deepEqual(monthlyCreditPolicy, {
    scheduledPercent: 60,
    retryReprocessingPercent: 20,
    priorityEmergencyPercent: 20,
    p2DeferAtTotalPercent: 80,
  });
  assert.deepEqual(dataset.quota_policy, {
    policy_version: "1.0.0",
    scheduled_percent: 60,
    retry_reprocessing_percent: 20,
    priority_emergency_percent: 20,
    p2_defer_at_total_percent: 80,
  });
  assert.equal(quotaDecision("P2", 79.99), "queue");
  assert.equal(quotaDecision("P2", 80), "deferred_quota");
  assert.equal(quotaDecision("P1", 100), "queue");
  assert.equal(quotaDecision("P0", 100), "queue");
});

test("catalogue query inputs come only from enabled, currently valid AOIs", () => {
  assert.ok(pilot);
  assert.deepEqual(
    enabledCatalogueQueries(dataset.features, new Date("2026-10-01T00:00:00Z")),
    [],
  );
  const enabled = structuredClone(pilot);
  enabled.properties.enabled = true;
  assert.deepEqual(
    enabledCatalogueQueries([enabled], new Date("2026-10-01T00:00:00Z")),
    [
      {
        aoiId: pilot.properties.aoi_id,
        policyVersion: pilot.properties.policy_version,
        geometry: pilot.geometry,
      },
    ],
  );
});

test("coverage-gap rows expose every required non-coverage status", () => {
  const gaps: CoverageGap[] = [
    "disabled",
    "deferred",
    "failed",
    "unobserved",
  ].map((status) => ({
    aoiId: "aoi:test",
    status: status as CoverageGap["status"],
    startsAt: "2026-10-01T00:00:00.000Z",
    endsAt: null,
    detail: `${status} test`,
  }));
  const rows = coverageGapRows(gaps);
  for (const status of ["disabled", "deferred", "failed", "unobserved"])
    assert.ok(rows.some((row) => row.includes(`| ${status} |`)));
});

test("Part 6 migration uses PostGIS and persists AOIs, policy, and gaps", () => {
  const sql = readFileSync(
    "supabase/migrations/20261001090000_part6_aois_and_quota.sql",
    "utf8",
  );
  assert.match(sql, /create extension if not exists postgis/u);
  assert.match(sql, /create table app_private\.aois/u);
  assert.match(sql, /st_isvalid\(area_geometry\)/u);
  assert.match(sql, /st_ispolygonccw\(area_geometry\)/u);
  assert.match(sql, /st_isempty\(area_geometry\)/u);
  assert.match(sql, /create table app_private\.monthly_credit_policies/u);
  assert.match(sql, /create table app_private\.coverage_gaps/u);
  assert.match(sql, /cost_estimate_status = 'estimated'/u);
});

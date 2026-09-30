/** Returns whether a numeric value is within the valid longitude range. */
export function isValidLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

export const monthlyCreditPolicy = {
  scheduledPercent: 60,
  retryReprocessingPercent: 20,
  priorityEmergencyPercent: 20,
  p2DeferAtTotalPercent: 80,
} as const;

export type AoiPriority = "P0" | "P1" | "P2";
export type QuotaDecision = "queue" | "deferred_quota";

export function quotaDecision(
  priority: AoiPriority,
  totalUsedPercent: number,
): QuotaDecision {
  if (!Number.isFinite(totalUsedPercent) || totalUsedPercent < 0)
    throw new Error("totalUsedPercent must be a non-negative finite number");
  return priority === "P2" && totalUsedPercent >= 80
    ? "deferred_quota"
    : "queue";
}

export interface VersionedAoiFeature {
  type: "Feature";
  properties: {
    aoi_id: string;
    enabled: boolean;
    policy_version: string;
    valid_from: string;
    valid_to: string | null;
  };
  geometry: Record<string, unknown>;
}

export interface CatalogueQuery {
  aoiId: string;
  policyVersion: string;
  geometry: Record<string, unknown>;
}

export function enabledCatalogueQueries(
  features: VersionedAoiFeature[],
  at: Date,
): CatalogueQuery[] {
  const instant = at.valueOf();
  return features
    .filter(({ properties }) => {
      const starts = new Date(properties.valid_from).valueOf();
      const ends =
        properties.valid_to === null
          ? Infinity
          : new Date(properties.valid_to).valueOf();
      return properties.enabled && starts <= instant && instant < ends;
    })
    .map(({ properties, geometry }) => ({
      aoiId: properties.aoi_id,
      policyVersion: properties.policy_version,
      geometry,
    }));
}

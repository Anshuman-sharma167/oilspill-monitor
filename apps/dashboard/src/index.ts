/** Part 6 data boundary. Interactive dashboard work remains in its later part. */
export const dashboardStatus = "coverage-status-only" as const;

export type CoverageGapStatus =
  "disabled" | "deferred" | "failed" | "unobserved";

export interface CoverageGap {
  aoiId: string;
  status: CoverageGapStatus;
  startsAt: string;
  endsAt: string | null;
  detail: string;
}

export function coverageGapRows(gaps: CoverageGap[]): string[] {
  return gaps.map(
    ({ aoiId, status, startsAt, endsAt, detail }) =>
      `${aoiId} | ${status} | ${startsAt} to ${endsAt ?? "open"} | ${detail}`,
  );
}

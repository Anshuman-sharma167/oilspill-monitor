export const candidateAssessments = [
  "oil-like slick candidate",
  "likely slick",
  "look-alike",
  "uncertain",
] as const;

export const reviewPriorities = ["low", "normal", "high"] as const;

export type CandidateAssessment = (typeof candidateAssessments)[number];
export type ReviewPriority = (typeof reviewPriorities)[number];

export interface CandidateInput {
  candidateId: string;
  observedAt: string;
  assessment: CandidateAssessment;
  reviewPriority: ReviewPriority;
}

export interface NormalizedCandidate {
  schemaVersion: "0.1.0";
  candidateId: string;
  observedAt: string;
  source: "synthetic-example";
  assessment: CandidateAssessment;
  reviewPriority: ReviewPriority;
  reviewStatus: "pending_manual_review";
  coordinatesIncluded: false;
}

export function normalizeCandidate(input: CandidateInput): NormalizedCandidate {
  const candidateId = input.candidateId.trim();
  if (candidateId.length === 0) {
    throw new Error("candidateId must not be empty");
  }

  if (!candidateAssessments.includes(input.assessment)) {
    throw new Error("assessment is not supported");
  }

  if (!reviewPriorities.includes(input.reviewPriority)) {
    throw new Error("reviewPriority is not supported");
  }

  const parsedObservedAt = new Date(input.observedAt);
  if (
    Number.isNaN(parsedObservedAt.valueOf()) ||
    parsedObservedAt.toISOString() !== input.observedAt
  ) {
    throw new Error("observedAt must be an ISO 8601 UTC timestamp");
  }

  return {
    schemaVersion: "0.1.0",
    candidateId,
    observedAt: input.observedAt,
    source: "synthetic-example",
    assessment: input.assessment,
    reviewPriority: input.reviewPriority,
    reviewStatus: "pending_manual_review",
    coordinatesIncluded: false,
  };
}
